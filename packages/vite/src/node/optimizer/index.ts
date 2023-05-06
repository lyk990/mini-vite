import type {
  DepOptimizationMetadata,
  ExportsData,
  OptimizedDepInfo,
} from "vite";
import { ResolvedConfig } from "../config";
import { ViteDevServer } from "../server";
import { createDebugger, normalizePath } from "../utils";
import path from "node:path";
import fsp from "node:fs/promises";
import { scanImports } from "./scan";
import { init } from "es-module-lexer";
// import { build } from "esbuild";
// import { PRE_BUNDLE_DIR } from "../constants";
export { getDepsOptimizer } from "./optimizer";

const debug = createDebugger("vite:deps");
/*初始化预构建依赖 */
export async function initDepsOptimizer(
  config: ResolvedConfig,
  server?: ViteDevServer
) {
  await createDepsOptimizer(config, server);
}

async function createDepsOptimizer(
  config: ResolvedConfig,
  server?: ViteDevServer
): Promise<void> {
  // const isBuild = false;
  // const { logger } = config;
  // const sessionTimestamp = Date.now().toString();
  const cachedMetadata = await loadCachedDepOptimizationMetadata(config, false);
  let discover;
  if (!cachedMetadata) {
    discover = discoverProjectDependencies(config);
    await discover.result;
    discover = undefined;
    // TODO 依赖预构建
    // runOptimizeDeps(config, deps);
    // const root = normalizePath(process.cwd());
    // await build({
    //   entryPoints: [...deps],
    //   write: true,
    //   bundle: true,
    //   format: "esm",
    //   splitting: true,
    //   outdir: path.resolve(root, PRE_BUNDLE_DIR),
    //   plugins: [preBundlePlugin(deps)],
    // });
  }
}

/**查看预构建依赖缓存 */
export async function loadCachedDepOptimizationMetadata(
  config: ResolvedConfig,
  ssr: boolean,
  force = config.optimizeDeps.force,
  asCommand = false
): Promise<DepOptimizationMetadata | undefined> {
  const log = asCommand ? config.logger.info : debug;
  const depsCacheDir = getDepsCacheDir(config, ssr);
  if (!force) {
    let cachedMetadata: DepOptimizationMetadata | undefined;
    try {
      const cachedMetadataPath = path.join(depsCacheDir, "_metadata.json");
      cachedMetadata = parseDepsOptimizerMetadata(
        await fsp.readFile(cachedMetadataPath, "utf-8"),
        depsCacheDir
      );
    } catch (e) {}
    // 比较hash是否一直来判断需不需要重复预构建依赖
    if (cachedMetadata && cachedMetadata.hash === getDepHash(config, ssr)) {
      log?.("Hash is consistent. Skipping. Use --force to override.");
      return cachedMetadata;
    }
  } else {
    config.logger.info("Forced re-optimization of dependencies");
  }
  await fsp.rm(depsCacheDir, { recursive: true, force: true });
}

export function getDepsCacheDir(config: ResolvedConfig, ssr: boolean): string {
  return normalizePath(path.resolve("node_modules/.-pre-mini-vite", "deps"));
}

function parseDepsOptimizerMetadata(
  jsonMetadata: string,
  depsCacheDir: string
): DepOptimizationMetadata | undefined {
  const { hash, browserHash, optimized, chunks } = JSON.parse(
    jsonMetadata,
    (key: string, value: string) => {
      // Paths can be absolute or relative to the deps cache dir where
      // the _metadata.json is located
      if (key === "file" || key === "src") {
        return normalizePath(path.resolve(depsCacheDir, value));
      }
      return value;
    }
  );
  if (
    !chunks ||
    Object.values(optimized).some((depInfo: any) => !depInfo.fileHash)
  ) {
    // outdated _metadata.json version, ignore
    return;
  }
  const metadata = {
    hash,
    browserHash,
    optimized: {},
    discovered: {},
    chunks: {},
    depInfoList: [],
  };
  for (const id of Object.keys(optimized)) {
    addOptimizedDepInfo(metadata, "optimized", {
      ...optimized[id],
      id,
      browserHash,
    });
  }
  for (const id of Object.keys(chunks)) {
    addOptimizedDepInfo(metadata, "chunks", {
      ...chunks[id],
      id,
      browserHash,
      needsInterop: false,
    });
  }
  return metadata;
}
export function addOptimizedDepInfo(
  metadata: DepOptimizationMetadata,
  type: "optimized" | "discovered" | "chunks",
  depInfo: OptimizedDepInfo
): OptimizedDepInfo {
  metadata[type][depInfo.id] = depInfo;
  metadata.depInfoList.push(depInfo);
  return depInfo;
}

export function getDepHash(config: ResolvedConfig, ssr: boolean): string {
  return "false";
}
/**查找项目预构建依赖 */
export function discoverProjectDependencies(config: ResolvedConfig): {
  cancel: () => Promise<void>;
  result: Promise<Record<string, string>>;
} {
  const { cancel, result } = scanImports(config);
  return {
    cancel,
    result: result.then(({ deps, missing: _missing }) => {
      return deps;
    }),
  };
}

// export function runOptimizeDeps(
//   resolvedConfig: ResolvedConfig,
//   depsInfo: Record<string, OptimizedDepInfo>
// ): {
//   cancel: () => Promise<void>;
//   result: Promise<DepOptimizationResult>;
// } {}

// export function optimizedDepInfoFromFile(
//   metadata: DepOptimizationMetadata,
//   file: string
// ): OptimizedDepInfo | undefined {
//   return metadata.depInfoList.find((depInfo) => depInfo.file === file);
// }

// export async function extractExportsData(
//   filePath: string,
//   config: ResolvedConfig,
//   ssr: boolean
// ): Promise<ExportsData> {
//   await init;

//   const optimizeDeps = getDepOptimizationConfig(config, ssr);

//   const esbuildOptions = optimizeDeps?.esbuildOptions ?? {};
//   if (optimizeDeps.extensions?.some((ext) => filePath.endsWith(ext))) {
//     // For custom supported extensions, build the entry file to transform it into JS,
//     // and then parse with es-module-lexer. Note that the `bundle` option is not `true`,
//     // so only the entry file is being transformed.
//     const result = await build({
//       ...esbuildOptions,
//       entryPoints: [filePath],
//       write: false,
//       format: "esm",
//     });
//     const [imports, exports] = parse(result.outputFiles[0].text);
//     return {
//       hasImports: imports.length > 0,
//       exports: exports.map((e) => e.n),
//     };
//   }

//   let parseResult: ReturnType<typeof parse>;
//   let usedJsxLoader = false;

//   const entryContent = await fsp.readFile(filePath, "utf-8");
//   try {
//     parseResult = parse(entryContent);
//   } catch {
//     const loader = esbuildOptions.loader?.[path.extname(filePath)] || "jsx";
//     debug?.(
//       `Unable to parse: ${filePath}.\n Trying again with a ${loader} transform.`
//     );
//     const transformed = await transformWithEsbuild(entryContent, filePath, {
//       loader,
//     });
//     parseResult = parse(transformed.code);
//     usedJsxLoader = true;
//   }

//   const [imports, exports] = parseResult;
//   const exportsData: ExportsData = {
//     hasImports: imports.length > 0,
//     exports: exports.map((e) => e.n),
//     jsxLoader: usedJsxLoader,
//   };
//   return exportsData;
// }

// function needsInterop(
//   config: ResolvedConfig,
//   ssr: boolean,
//   id: string,
//   exportsData: ExportsData,
//   output?: { exports: string[] }
// ): boolean {
//   if (getDepOptimizationConfig(config, ssr)?.needsInterop?.includes(id)) {
//     return true;
//   }
//   const { hasImports, exports } = exportsData;
//   // entry has no ESM syntax - likely CJS or UMD
//   if (!exports.length && !hasImports) {
//     return true;
//   }

//   if (output) {
//     // if a peer dependency used require() on an ESM dependency, esbuild turns the
//     // ESM dependency's entry chunk into a single default export... detect
//     // such cases by checking exports mismatch, and force interop.
//     const generatedExports: string[] = output.exports;

//     if (
//       !generatedExports ||
//       (isSingleDefaultExport(generatedExports) &&
//         !isSingleDefaultExport(exports))
//     ) {
//       return true;
//     }
//   }
//   return false;
// }

// export async function optimizedDepNeedsInterop(
//   metadata: DepOptimizationMetadata,
//   file: string,
//   config: ResolvedConfig,
//   ssr: boolean
// ): Promise<boolean | undefined> {
//   const depInfo = optimizedDepInfoFromFile(metadata, file);
//   if (depInfo?.src && depInfo.needsInterop === undefined) {
//     depInfo.exportsData ??= extractExportsData(depInfo.src, config, ssr);
//     depInfo.needsInterop = needsInterop(
//       config,
//       ssr,
//       depInfo.id,
//       await depInfo.exportsData
//     );
//   }
//   return depInfo?.needsInterop;
// }
