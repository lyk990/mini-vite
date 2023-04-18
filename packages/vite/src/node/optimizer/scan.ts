import esbuild, { BuildContext, Plugin } from "esbuild";
import { ResolvedConfig } from "../config";
import { BARE_IMPORT_RE, EXTERNAL_TYPES } from "../constants";
import glob from "fast-glob";
import { createPluginContainer, PluginContainer } from "../pluginContainer";
import path from "node:path";
import { normalizePath } from "../utils";
const htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/;
type ResolveIdOptions = Parameters<PluginContainer["resolveId"]>[2];

export function scanImports(config: ResolvedConfig): {
  cancel: () => Promise<void>;
  result: Promise<{
    deps: Record<string, string>;
    missing: Record<string, string>;
  }>;
} {
  //依赖扫描入口文件
  const deps: Record<string, string> = {};
  const missing: Record<string, string> = {};
  let entries: string[];
  const scanContext = { cancelled: false };

  const esbuildContext: Promise<BuildContext | undefined> = computeEntries(
    config
  ).then((computedEntries) => {
    entries = computedEntries;
    return prepareEsbuildScanner(config, entries, deps, missing, scanContext);
  });

  const result = esbuildContext.then((context) => {
    //  如果没有扫描到入口文件，直接返回
    if (!context || scanContext?.cancelled) {
      return { deps: {}, missing: {} };
    }
    return context.rebuild().then(() => {
      return {
        deps: orderedDependencies(deps),
        missing,
      };
    });
  });
  return {
    cancel: async () => {},
    result,
  };
}

function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[]
): Plugin {
  // 对路径进行处理
  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions
  ) => {
    const seen = new Map<string, string | undefined>();
    const key = id + (importer && path.dirname(importer));
    if (seen.has(key)) {
      return seen.get(key);
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      }
    );
    const res = resolved?.id;
    seen.set(key, res);
    return res;
  };
  return {
    name: "vite:dep-scan",
    setup(build) {
      //  TODO 依赖预构建未完成
      // 忽略的文件类型
      build.onResolve(
        { filter: new RegExp(`\\.(${EXTERNAL_TYPES.join("|")})$`) },
        ({ path }) => {
          return {
            path,
            external: true,
          };
        }
      );
      // 忽略的文件类型
      // build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
      //   console.log("pat111h", path);
      //   console.log("importer", importer);
      //   const resolved = await resolve(path, importer);
      //   if (!resolved) return;
      //   console.log(path, "path");
      //   return {
      //     path: resolved,
      //     namespace: "html",
      //   };
      // });
      // 记录依赖
      // build.onLoad({ filter: htmlTypesRE,namespace: "html", }, async ({ path }) => {
      // });
    },
  };
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps);
  depsList.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(depsList);
}
/**找出入口文件 */
async function computeEntries(config: ResolvedConfig) {
  let entries: string[] = [];
  // 优先使用配置的入口文件
  const explicitEntryPatterns = config.optimizeDeps.entries;
  if (!explicitEntryPatterns) {
    // TODO 依赖预构建未完成
    entries = await globEntries("**/main.ts", config);
  }
  return entries;
}
function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      "**/node_modules/**",
      `**/${config.build.outDir}/**`,
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true,
    suppressErrors: true, // suppress EACCES errors
  });
}

async function prepareEsbuildScanner(
  config: ResolvedConfig,
  entries: string[],
  deps: Record<string, string>,
  missing: Record<string, string>,
  _scanContext?: { cancelled: boolean }
): Promise<BuildContext | undefined> {
  // TODO依赖预构建未完成
  const container = await createPluginContainer(config);
  const plugin = esbuildScanPlugin(config, container, deps, missing, entries);
  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {};

  return await esbuild.context({
    absWorkingDir: process.cwd(),
    write: false,
    stdin: {
      contents: entries.map((e) => `import ${JSON.stringify(e)}`).join("\n"),
      loader: "js",
    },
    bundle: true,
    format: "esm",
    logLevel: "silent",
    plugins: [...plugins, plugin],
    ...esbuildOptions,
  });
}
