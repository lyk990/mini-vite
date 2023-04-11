import esbuild, { BuildContext, Plugin } from "esbuild";
import { ResolvedConfig } from "../config";
import path from "node:path";
import { BARE_IMPORT_RE, EXTERNAL_TYPES } from "../constants";
import { green } from "picocolors";
import glob from "fast-glob";

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
  const esbuildContext = computeEntries(config);
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

export function esbuildScanPlugin(deps: Set<string>): Plugin {
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

// function orderedDependencies(deps: Set<string>) {
//   const depsList = Object.entries(deps);
//   depsList.sort((a, b) => a[0].localeCompare(b[0]));
//   return Object.fromEntries(depsList);
// }
async function computeEntries(config: ResolvedConfig) {
  let entries: string[] = [];
  const explicitEntryPatterns = config.optimizeDeps.entries;
  entries = await globEntries(explicitEntryPatterns, config);
}
function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      "**/node_modules/**",
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
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
  scanContext?: { cancelled: boolean }
): Promise<BuildContext | undefined> {}
