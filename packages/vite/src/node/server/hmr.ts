import { ViteDevServer } from ".";
import { createDebugger, normalizePath, unique, wrapId } from "../utils";
import path from "node:path";
import colors from "picocolors";
import { CLIENT_DIR } from "../constants";
import { HmrContext, isCSSRequest, ModuleNode } from "vite";
import fsp from "node:fs/promises";
import type { Update } from "types/hmrPayload";
import { isExplicitImportRequired } from "../plugins/importAnalysis";
import { getAffectedGlobModules } from "../plugins/importMetaGlob";

export function getShortName(file: string, root: string): string {
  return file.startsWith(root + "/") ? path.posix.relative(root, file) : file;
}
export const debugHmr = createDebugger("vite:hmr");
const normalizedClientDir = normalizePath(CLIENT_DIR);

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

  if (file.startsWith(normalizedClientDir)) {
    ws.send({
      type: "full-reload",
      path: "*",
    });
    return;
  }

  const mods = moduleGraph.getModulesByFile(file);

  const timestamp = Date.now();
  const hmrContext: HmrContext = {
    file,
    timestamp,
    modules: mods ? [...mods] : [],
    read: () => readModifiedFile(file),
    server: server as any,
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
      debugHmr?.(`[no modules matched] ${colors.dim(shortFile)}`);
    }
    return;
  }

  updateModules(shortFile, hmrContext.modules, timestamp, server);
}

/**给浏览器端推送消息 */
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

async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, "utf-8");
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs;
    await new Promise((r) => {
      let n = 0;
      const poll = async () => {
        n++;
        const newMtime = (await fsp.stat(file)).mtimeMs;
        if (newMtime !== mtime || n > 10) {
          r(0);
        } else {
          setTimeout(poll, 10);
        }
      };
      setTimeout(poll, 10);
    });
    return await fsp.readFile(file, "utf-8");
  } else {
    return content;
  }
}

function propagateUpdate(
  node: ModuleNode,
  traversedModules: Set<ModuleNode>,
  boundaries: { boundary: ModuleNode; acceptedVia: ModuleNode }[],
  currentChain: ModuleNode[] = [node]
): boolean /* hasDeadEnd */ {
  if (traversedModules.has(node)) {
    return false;
  }
  traversedModules.add(node);

  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id
      )}`
    );
    return false;
  }

  if (node.isSelfAccepting) {
    boundaries.push({ boundary: node, acceptedVia: node });

    for (const importer of node.importers) {
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        propagateUpdate(
          importer,
          traversedModules,
          boundaries,
          currentChain.concat(importer)
        );
      }
    }

    return false;
  }

  if (node.acceptedHmrExports) {
    boundaries.push({ boundary: node, acceptedVia: node });
  } else {
    if (!node.importers.size) {
      return true;
    }
    if (
      !isCSSRequest(node.url) &&
      [...node.importers].every((i) => isCSSRequest(i.url))
    ) {
      return true;
    }
  }

  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer);
    if (importer.acceptedHmrDeps.has(node)) {
      boundaries.push({ boundary: importer, acceptedVia: node });
      continue;
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      const importedBindingsFromNode = importer.importedBindings.get(node.id);
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue;
      }
    }

    if (currentChain.includes(importer)) {
      return true;
    }

    if (propagateUpdate(importer, traversedModules, boundaries, subChain)) {
      return true;
    }
  }
  return false;
}

export function normalizeHmrUrl(url: string): string {
  if (url[0] !== "." && url[0] !== "/") {
    url = wrapId(url);
  }
  return url;
}

function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false;
    }
  }
  return true;
}
