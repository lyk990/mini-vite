import esbuild, { formatMessages, transform, Plugin } from "esbuild";
import { ResolvedConfig } from "../config";
import path from "node:path";
import { BARE_IMPORT_RE, EXTERNAL_TYPES } from "../constants";
import { green } from "picocolors";

export async function scanImports(config: ResolvedConfig): {
  cancel: () => Promise<void>;
  result: Promise<{
    deps: Record<string, string>;
    missing: Record<string, string>;
  }>;
} {
  let entries: string;
  // const esbuildContext: Promise<BuildContext | undefined> = computeEntries(
  //   config,
  // ).
  //依赖扫描入口文件
  entries = path.resolve(process.cwd(), "index.html");
  console.log("entries", entries);
  let res: any;
  const deps = new Set<string>();
  await esbuild.build({
    entryPoints: [entries],
    bundle: true,
    write: false,
    plugins: [esbuildScanPlugin(deps)],
  });
  console.log("deps", deps);
  console.log(
    `${green("需要预构建的依赖")}:\n${[...deps]
      .map(green)
      .map((item) => `  ${item}`)
      .join("\n")}\n`
  );
  return res;
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
