import { ViteDevServer } from ".";
import { createDebugger, normalizePath } from "../utils";
import path from "node:path";
import colors from 'picocolors'

export function getShortName(file: string, root: string): string {
  return file.startsWith(root + "/") ? path.posix.relative(root, file) : file;
}
export const debugHmr = createDebugger('vite:hmr')

export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer,
  configOnly: boolean
): Promise<void> {
  const { ws, config, moduleGraph } = server;
  const shortFile = getShortName(file, config.root);
  const fileName = path.basename(file);

  const isConfig = file === config.configFile;
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name
  );
  const isEnv =
    config.inlineConfig.envFile !== false &&
    (fileName === ".env" || fileName.startsWith(".env."));
  if (isConfig || isConfigDependency || isEnv) {
    // auto restart server
    debugHmr?.(`[config change] ${colors.dim(shortFile)}`);
    config.logger.info(
      colors.green(
        `${path.relative(process.cwd(), file)} changed, restarting server...`
      ),
      { clear: true, timestamp: true }
    );
    try {
      await server.restart();
    } catch (e) {
      config.logger.error(colors.red(e));
    }
    return;
  }

  if (configOnly) {
    return;
  }

  debugHmr?.(`[file change] ${colors.dim(shortFile)}`);

  // (dev only) the client itself cannot be hot updated.
  if (file.startsWith(normalizedClientDir)) {
    ws.send({
      type: "full-reload",
      path: "*",
    });
    return;
  }

  const mods = moduleGraph.getModulesByFile(file);

  // check if any plugin wants to perform custom HMR handling
  const timestamp = Date.now();
  const hmrContext: HmrContext = {
    file,
    timestamp,
    modules: mods ? [...mods] : [],
    read: () => readModifiedFile(file),
    server,
  };

  for (const hook of config.getSortedPluginHooks("handleHotUpdate")) {
    const filteredModules = await hook(hmrContext);
    if (filteredModules) {
      hmrContext.modules = filteredModules;
    }
  }

  if (!hmrContext.modules.length) {
    // html file cannot be hot updated
    if (file.endsWith(".html")) {
      config.logger.info(colors.green(`page reload `) + colors.dim(shortFile), {
        clear: true,
        timestamp: true,
      });
      ws.send({
        type: "full-reload",
        path: config.server.middlewareMode
          ? "*"
          : "/" + normalizePath(path.relative(config.root, file)),
      });
    } else {
      // loaded but not in the module graph, probably not js
      debugHmr?.(`[no modules matched] ${colors.dim(shortFile)}`);
    }
    return;
  }

  updateModules(shortFile, hmrContext.modules, timestamp, server);
}

export function updateModules(
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  { config, ws, moduleGraph }: ViteDevServer,
  afterInvalidation?: boolean
): void {
  const updates: Update[] = [];
  const invalidatedModules = new Set<ModuleNode>();
  const traversedModules = new Set<ModuleNode>();
  let needFullReload = false;

  for (const mod of modules) {
    moduleGraph.invalidateModule(mod, invalidatedModules, timestamp, true);
    if (needFullReload) {
      continue;
    }

    const boundaries: { boundary: ModuleNode; acceptedVia: ModuleNode }[] = [];
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries);
    if (hasDeadEnd) {
      needFullReload = true;
      continue;
    }

    updates.push(
      ...boundaries.map(({ boundary, acceptedVia }) => ({
        type: `${boundary.type}-update` as const,
        timestamp,
        path: normalizeHmrUrl(boundary.url),
        explicitImportRequired:
          boundary.type === "js"
            ? isExplicitImportRequired(acceptedVia.url)
            : undefined,
        acceptedPath: normalizeHmrUrl(acceptedVia.url),
      }))
    );
  }

  if (needFullReload) {
    config.logger.info(colors.green(`page reload `) + colors.dim(file), {
      clear: !afterInvalidation,
      timestamp: true,
    });
    ws.send({
      type: "full-reload",
    });
    return;
  }

  if (updates.length === 0) {
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file));
    return;
  }

  config.logger.info(
    colors.green(`hmr update `) +
      colors.dim([...new Set(updates.map((u) => u.path))].join(", ")),
    { clear: !afterInvalidation, timestamp: true }
  );
  ws.send({
    type: "update",
    updates,
  });
}

export async function handleFileAddUnlink(
  file: string,
  server: ViteDevServer
): Promise<void> {
  const modules = [...(server.moduleGraph.getModulesByFile(file) || [])];

  modules.push(...getAffectedGlobModules(file, server));

  if (modules.length > 0) {
    updateModules(
      getShortName(file, server.config.root),
      unique(modules),
      Date.now(),
      server
    );
  }
}
