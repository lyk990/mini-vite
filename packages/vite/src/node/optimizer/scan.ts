import esbuild, { BuildContext, Plugin } from "esbuild";
import { ResolvedConfig } from "../config";
import path from "node:path";
import { BARE_IMPORT_RE, EXTERNAL_TYPES } from "../constants";
import { green } from "picocolors";
import glob from "fast-glob";
import { PluginContainer } from "vite";
import { createPluginContainer } from "../pluginContainer";

export function scanImports(config: ResolvedConfig): {
  cancel: () => Promise<void>;
  result: Promise<{
    deps: Record<string, string>;
    missing: Record<string, string>;
  }>;
} {
  //依赖扫描入口文件
  // let entries = path.resolve(process.cwd(), "src/main.ts");
  const deps: Record<string, string> = {};
  const missing: Record<string, string> = {};
  let entries: string[];
  const scanContext = { cancelled: false };

  const esbuildContext: Promise<BuildContext | undefined> = computeEntries(
    config
  ).then((computedEntries) => {
    entries = computedEntries;
    console.log("entries", entries);
    return prepareEsbuildScanner(config, entries, deps, missing, scanContext);
  });

  const result = esbuildContext.then((context) => {
    return context.rebuild().then(() => {
      return {
        deps: orderedDependencies(deps),
        missing,
      };
    });
  });
  // const result = esbuild
  //   .build({
  //     entryPoints: [entries],
  //     bundle: true,
  //     write: false,
  //     plugins: [esbuildScanPlugin(deps)],
  //   })
  //   .then(() => {
  //     console.log(
  //       `${green("需要预构建的依赖")}:\n${[...deps]
  //         .map(green)
  //         .map((item) => `  ${item}`)
  //         .join("\n")}\n`
  //     );
  //     return { deps, missing };
  //   });
  return {
    cancel: async () => {},
    result,
  };
}

export function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[]
): Plugin {
  return {
    name: "esbuild:scan-deps",
    setup(build) {
      // 忽略的文件类型
      build.onResolve(
        { filter: new RegExp(`\\.(${EXTERNAL_TYPES.join("|")})$`) },
        (resolveInfo) => {
          return {
            path: resolveInfo.path,
            external: true,
          };
        }
      );
      // 记录依赖
      build.onResolve(
        {
          filter: BARE_IMPORT_RE,
        },
        (resolveInfo) => {
          const { path: id } = resolveInfo;
          deps.add(id);
          return {
            path: id,
            external: true,
          };
        }
      );
    },
  };
}

function orderedDependencies(deps: Set<string>) {
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
    entries = await globEntries("**/*.html", config);
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
  const container = await createPluginContainer(config)

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
