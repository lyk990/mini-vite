import {
  DepOptimizationMetadata,
  DepOptimizationProcessing,
  DepOptimizationResult,
  OptimizedDepInfo,
  transformWithEsbuild,
} from "vite";
import { ResolvedConfig, getDepOptimizationConfig } from "../config";
import {
  createDebugger,
  flattenId,
  getHash,
  lookupFile,
  normalizePath,
  tryStatSync,
} from "../utils";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { scanImports } from "./scan";
import { init, parse } from "es-module-lexer";
import type { BuildContext } from "esbuild";
export { getDepsOptimizer } from "./optimizer";
import { promisify } from "node:util";
import esbuild, { build } from "esbuild";
import { ESBUILD_MODULES_TARGET } from "../constants";
import { esbuildDepPlugin } from "./esbuildDepPlugin ";

const debug = createDebugger("vite:deps");

const jsExtensionRE = /\.js$/i;
const jsMapExtensionRE = /\.js\.map$/i;

export type ExportsData = {
  hasImports: boolean;
  exports: readonly string[];
  jsxLoader?: boolean;
};

/**查看预构建依赖缓存 */
export async function loadCachedDepOptimizationMetadata(
  config: ResolvedConfig,
  ssr: boolean = false,
  force = config.optimizeDeps.force,
  asCommand = false
): Promise<DepOptimizationMetadata | undefined> {
  const log = debug;
  const depsCacheDir = getDepsCacheDir(config, ssr);
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
  // 删除预构建依赖文件和目录
  await fsp.rm(depsCacheDir, { recursive: true, force: true });
}

export function getDepsCacheDir(config: ResolvedConfig, ssr: boolean): string {
  return getDepsCacheDirPrefix(config) + getDepsCacheSuffix(config, ssr);
}

function parseDepsOptimizerMetadata(
  jsonMetadata: string,
  depsCacheDir: string
): DepOptimizationMetadata | undefined {
  const { hash, browserHash, optimized, chunks } = JSON.parse(
    jsonMetadata,
    (key: string, value: string) => {
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

/**查找node_modules中的依赖并放到deps中 */
export function discoverProjectDependencies(config: ResolvedConfig): {
  cancel: () => Promise<void>;
  result: Promise<Record<string, string>>;
} {
  const { cancel, result } = scanImports(config);
  return {
    cancel,
    result: result.then(({ deps, missing }) => {
      const missingIds = Object.keys(missing);
      if (missingIds.length) {
        console.log("引入依赖但是无法解析，是否重新下载");
      }
      return deps;
    }),
  };
}

export function runOptimizeDeps(
  resolvedConfig: ResolvedConfig,
  depsInfo: Record<string, OptimizedDepInfo>,
  ssr: boolean = false
): {
  cancel: () => Promise<void>;
  result: Promise<DepOptimizationResult>;
} {
  const optimizerContext = { cancelled: false };

  const config: ResolvedConfig = {
    ...resolvedConfig,
    command: "build",
  };

  const depsCacheDir = getDepsCacheDir(resolvedConfig, ssr);
  const processingCacheDir = getProcessingDepsCacheDir(resolvedConfig, ssr);

  fs.mkdirSync(processingCacheDir, { recursive: true });

  fs.writeFileSync(
    path.resolve(processingCacheDir, "package.json"),
    `{\n  "type": "module"\n}\n`
  );

  const metadata = initDepsOptimizerMetadata(config, ssr);

  metadata.browserHash = getOptimizedBrowserHash(
    metadata.hash,
    depsFromOptimizedDepInfo(depsInfo)
  );

  const cleanUp = () => {
    fsp
      .rm(processingCacheDir, { recursive: true, force: true })
      .catch(() => {});
  };

  const succesfulResult: DepOptimizationResult = {
    metadata,
    cancel: cleanUp,
    commit: async () => {
      const dataPath = path.join(processingCacheDir, "_metadata.json");
      fs.writeFileSync(
        dataPath,
        stringifyDepsOptimizerMetadata(metadata, depsCacheDir)
      );

      const temporalPath = depsCacheDir + getTempSuffix();
      const depsCacheDirPresent = fs.existsSync(depsCacheDir);

      if (depsCacheDirPresent) await safeRename(depsCacheDir, temporalPath);
      await safeRename(processingCacheDir, depsCacheDir);

      if (depsCacheDirPresent)
        fsp.rm(temporalPath, { recursive: true, force: true });
    },
  };

  const cancelledResult: DepOptimizationResult = {
    metadata,
    commit: async () => cleanUp(),
    cancel: cleanUp,
  };

  const start = performance.now();

  const preparedRun = prepareEsbuildOptimizerRun(
    resolvedConfig,
    depsInfo,
    ssr,
    processingCacheDir,
    optimizerContext
  );

  const runResult = preparedRun.then(({ context, idToExports }) => {
    function disposeContext() {
      return context?.dispose().catch((e) => {
        config.logger.error("Failed to dispose esbuild context", { error: e });
      });
    }
    if (!context || optimizerContext.cancelled) {
      disposeContext();
      return cancelledResult;
    }

    return context
      .rebuild()
      .then((result) => {
        const meta = result.metafile!;

        // the paths in `meta.outputs` are relative to `process.cwd()`
        const processingCacheDirOutputPath = path.relative(
          process.cwd(),
          processingCacheDir
        );

        for (const id in depsInfo) {
          const output = esbuildOutputFromId(
            meta.outputs,
            id,
            processingCacheDir
          );

          const { exportsData, ...info } = depsInfo[id];
          addOptimizedDepInfo(metadata, "optimized", {
            ...info,
            // We only need to hash the output.imports in to check for stability, but adding the hash
            // and file path gives us a unique hash that may be useful for other things in the future
            fileHash: getHash(
              metadata.hash + depsInfo[id].file + JSON.stringify(output.imports)
            ),
            browserHash: metadata.browserHash,
            // After bundling we have more information and can warn the user about legacy packages
            // that require manual configuration
            needsInterop: needsInterop(
              config,
              ssr,
              id,
              idToExports[id],
              output
            ),
          });
        }

        for (const o of Object.keys(meta.outputs)) {
          if (!o.match(jsMapExtensionRE)) {
            const id = path
              .relative(processingCacheDirOutputPath, o)
              .replace(jsExtensionRE, "");
            const file = getOptimizedDepPath(id, resolvedConfig, ssr);
            if (
              !findOptimizedDepInfoInRecord(
                metadata.optimized,
                (depInfo) => depInfo.file === file
              )
            ) {
              addOptimizedDepInfo(metadata, "chunks", {
                id,
                file,
                needsInterop: false,
                browserHash: metadata.browserHash,
              });
            }
          }
        }

        debug?.(
          `Dependencies bundled in ${(performance.now() - start).toFixed(2)}ms`
        );

        return succesfulResult;
      })

      .catch((e) => {
        if (e.errors && e.message.includes("The build was canceled")) {
          // esbuild logs an error when cancelling, but this is expected so
          // return an empty result instead
          return cancelledResult;
        }
        throw e;
      })
      .finally(() => {
        return disposeContext();
      });
  });

  runResult.catch(() => {
    cleanUp();
  });

  return {
    async cancel() {
      optimizerContext.cancelled = true;
      const { context } = await preparedRun;
      await context?.cancel();
      cleanUp();
    },
    result: runResult,
  };
}

function getProcessingDepsCacheDir(config: ResolvedConfig, ssr: boolean) {
  return (
    getDepsCacheDirPrefix(config) +
    getDepsCacheSuffix(config, ssr) +
    getTempSuffix()
  );
}
function getDepsCacheDirPrefix(config: ResolvedConfig): string {
  return normalizePath(path.resolve(config.cacheDir, "deps"));
}

function getDepsCacheSuffix(config: ResolvedConfig, ssr: boolean): string {
  let suffix = "";
  if (config.command === "build") {
    // Differentiate build caches depending on outDir to allow parallel builds
    const { outDir } = config.build;
    const buildId =
      outDir.length > 8 || outDir.includes("/") ? getHash(outDir) : outDir;
    suffix += `_build-${buildId}`;
  }
  if (ssr) {
    suffix += "_ssr";
  }
  return suffix;
}

function getTempSuffix() {
  return (
    "_temp_" +
    getHash(
      `${process.pid}:${Date.now().toString()}:${Math.random()
        .toString(16)
        .slice(2)}`
    )
  );
}
const GRACEFUL_RENAME_TIMEOUT = 5000;

function stringifyDepsOptimizerMetadata(
  metadata: DepOptimizationMetadata,
  depsCacheDir: string
) {
  const { hash, browserHash, optimized, chunks } = metadata;
  return JSON.stringify(
    {
      hash,
      browserHash,
      optimized: Object.fromEntries(
        Object.values(optimized).map(
          ({ id, src, file, fileHash, needsInterop }) => [
            id,
            {
              src,
              file,
              fileHash,
              needsInterop,
            },
          ]
        )
      ),
      chunks: Object.fromEntries(
        Object.values(chunks).map(({ id, file }) => [id, { file }])
      ),
    },
    (key: string, value: string) => {
      if (key === "file" || key === "src") {
        return normalizePath(path.relative(depsCacheDir, value));
      }
      return value;
    },
    2
  );
}

async function prepareEsbuildOptimizerRun(
  resolvedConfig: ResolvedConfig,
  depsInfo: Record<string, OptimizedDepInfo>,
  ssr: boolean,
  processingCacheDir: string,
  optimizerContext: { cancelled: boolean }
): Promise<{
  context?: BuildContext;
  idToExports: Record<string, ExportsData>;
}> {
  const isBuild = resolvedConfig.command === "build";
  const config: ResolvedConfig = {
    ...resolvedConfig,
    command: "build",
  };

  const flatIdDeps: Record<string, string> = {};
  const idToExports: Record<string, ExportsData> = {};
  const flatIdToExports: Record<string, ExportsData> = {};

  const optimizeDeps = config.optimizeDeps;

  const { plugins: pluginsFromConfig = [], ...esbuildOptions } =
    optimizeDeps?.esbuildOptions ?? {};

  await Promise.all(
    Object.keys(depsInfo).map(async (id) => {
      const src = depsInfo[id].src!;
      const exportsData = await (depsInfo[id].exportsData ??
        extractExportsData(src, config, ssr));
      if (exportsData.jsxLoader && !esbuildOptions.loader?.[".js"]) {
        esbuildOptions.loader = {
          ".js": "jsx",
          ...esbuildOptions.loader,
        };
      }
      const flatId = flattenId(id);
      flatIdDeps[flatId] = src;
      idToExports[id] = exportsData;
      flatIdToExports[flatId] = exportsData;
    })
  );

  if (optimizerContext.cancelled) return { context: undefined, idToExports };
  const define = {
    "process.env.NODE_ENV": isBuild
      ? "__vite_process_env_NODE_ENV"
      : JSON.stringify(process.env.NODE_ENV || config.mode),
  };

  const platform =
    ssr && config.ssr?.target !== "webworker" ? "node" : "browser";

  const external = [...(optimizeDeps?.exclude ?? [])];

  if (isBuild) {
    let rollupOptionsExternal = config?.build?.rollupOptions?.external;
    if (rollupOptionsExternal) {
      if (typeof rollupOptionsExternal === "string") {
        rollupOptionsExternal = [rollupOptionsExternal];
      }
      if (
        !Array.isArray(rollupOptionsExternal) ||
        rollupOptionsExternal.some((ext) => typeof ext !== "string")
      ) {
        throw new Error(
          `[vite] 'build.rollupOptions.external' can only be an array of strings or a string when using esbuild optimization at build time.`
        );
      }
      external.push(...(rollupOptionsExternal as string[]));
    }
  }

  const plugins = [...pluginsFromConfig];
  // if (external.length) {
  //   plugins.push(esbuildCjsExternalPlugin(external, platform));
  // }
  plugins.push(esbuildDepPlugin(flatIdDeps, external, config, ssr));

  const context = await esbuild.context({
    absWorkingDir: process.cwd(),
    entryPoints: Object.keys(flatIdDeps),
    platform,
    define,
    format: "esm",
    banner:
      platform === "node"
        ? {
            js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`,
          }
        : undefined,
    target: isBuild ? config.build.target || undefined : ESBUILD_MODULES_TARGET,
    external,
    logLevel: "error",
    splitting: true,
    sourcemap: true,
    outdir: processingCacheDir,
    ignoreAnnotations: !isBuild,
    metafile: true,
    plugins,
    charset: "utf8",
    ...esbuildOptions,
    supported: {
      "dynamic-import": true,
      "import-meta": true,
      ...esbuildOptions.supported,
    },
  });
  return { context, idToExports };
}

const safeRename = promisify(function gracefulRename(
  from: string,
  to: string,
  cb: (error: NodeJS.ErrnoException | null) => void
) {
  const start = Date.now();
  let backoff = 0;
  fs.rename(from, to, function CB(er) {
    if (
      er &&
      (er.code === "EACCES" || er.code === "EPERM") &&
      Date.now() - start < GRACEFUL_RENAME_TIMEOUT
    ) {
      setTimeout(function () {
        fs.stat(to, function (stater, st) {
          if (stater && stater.code === "ENOENT") fs.rename(from, to, CB);
          else CB(er);
        });
      }, backoff);
      if (backoff < 100) backoff += 10;
      return;
    }
    if (cb) cb(er);
  });
});

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

export function initDepsOptimizerMetadata(
  config: ResolvedConfig,
  ssr: boolean,
  timestamp?: string
): DepOptimizationMetadata {
  const hash = getDepHash(config, ssr);
  return {
    hash,
    browserHash: getOptimizedBrowserHash(hash, {}, timestamp),
    optimized: {},
    chunks: {},
    discovered: {},
    depInfoList: [],
  };
}

function getOptimizedBrowserHash(
  hash: string,
  deps: Record<string, string>,
  timestamp = ""
) {
  return getHash(hash + JSON.stringify(deps) + timestamp);
}

export function getOptimizedDepPath(
  id: string,
  config: ResolvedConfig,
  ssr: boolean
): string {
  return normalizePath(
    path.resolve(getDepsCacheDir(config, ssr), flattenId(id) + ".js")
  );
}

export function depsFromOptimizedDepInfo(
  depsInfo: Record<string, OptimizedDepInfo>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(depsInfo).map((d) => [d[0], d[1].src!])
  );
}

export function newDepOptimizationProcessing(): DepOptimizationProcessing {
  let resolve: () => void;
  const promise = new Promise((_resolve) => {
    resolve = _resolve;
  }) as Promise<void>;
  return { promise, resolve: resolve! };
}

export async function extractExportsData(
  filePath: string,
  config: ResolvedConfig,
  ssr: boolean
): Promise<ExportsData> {
  await init;

  const optimizeDeps = config.optimizeDeps;

  const esbuildOptions = optimizeDeps?.esbuildOptions ?? {};
  if (optimizeDeps.extensions?.some((ext) => filePath.endsWith(ext))) {
    const result = await build({
      ...esbuildOptions,
      entryPoints: [filePath],
      write: false,
      format: "esm",
    });
    const [imports, exports] = parse(result.outputFiles[0].text);
    return {
      hasImports: imports.length > 0,
      exports: exports.map((e) => e.n),
    };
  }

  let parseResult: ReturnType<typeof parse>;
  let usedJsxLoader = false;

  const entryContent = await fsp.readFile(filePath, "utf-8");
  try {
    parseResult = parse(entryContent);
  } catch {
    const loader = esbuildOptions.loader?.[path.extname(filePath)] || "jsx";
    debug?.(
      `Unable to parse: ${filePath}.\n Trying again with a ${loader} transform.`
    );
    const transformed = await transformWithEsbuild(entryContent, filePath, {
      loader,
    });
    parseResult = parse(transformed.code);
    usedJsxLoader = true;
  }

  const [imports, exports] = parseResult;
  const exportsData: ExportsData = {
    hasImports: imports.length > 0,
    exports: exports.map((e) => e.n),
    jsxLoader: usedJsxLoader,
  };
  return exportsData;
}

function findOptimizedDepInfoInRecord(
  dependenciesInfo: Record<string, OptimizedDepInfo>,
  callbackFn: (depInfo: OptimizedDepInfo, id: string) => any
): OptimizedDepInfo | undefined {
  for (const o of Object.keys(dependenciesInfo)) {
    const info = dependenciesInfo[o];
    if (callbackFn(info, o)) {
      return info;
    }
  }
}

function esbuildOutputFromId(
  outputs: Record<string, any>,
  id: string,
  cacheDirOutputPath: string
): any {
  const cwd = process.cwd();
  const flatId = flattenId(id) + ".js";
  const normalizedOutputPath = normalizePath(
    path.relative(cwd, path.join(cacheDirOutputPath, flatId))
  );
  const output = outputs[normalizedOutputPath];
  if (output) {
    return output;
  }
  for (const [key, value] of Object.entries(outputs)) {
    if (normalizePath(path.relative(cwd, key)) === normalizedOutputPath) {
      return value;
    }
  }
}

function needsInterop(
  config: ResolvedConfig,
  ssr: boolean,
  id: string,
  exportsData: ExportsData,
  output?: { exports: string[] }
): boolean {
  if (getDepOptimizationConfig(config, ssr)?.needsInterop?.includes(id)) {
    return true;
  }
  const { hasImports, exports } = exportsData;
  // entry has no ESM syntax - likely CJS or UMD
  if (!exports.length && !hasImports) {
    return true;
  }

  if (output) {
    const generatedExports: string[] = output.exports;

    if (
      !generatedExports ||
      (isSingleDefaultExport(generatedExports) &&
        !isSingleDefaultExport(exports))
    ) {
      return true;
    }
  }
  return false;
}

function isSingleDefaultExport(exports: readonly string[]) {
  return exports.length === 1 && exports[0] === "default";
}

const lockfileFormats = [
  { name: "package-lock.json", checkPatches: true, manager: "npm" },
  { name: "yarn.lock", checkPatches: true, manager: "yarn" }, // Included in lockfile for v2+
  { name: "pnpm-lock.yaml", checkPatches: false, manager: "pnpm" }, // Included in lockfile
  { name: "bun.lockb", checkPatches: true, manager: "bun" },
].sort((_, { manager }) => {
  return process.env.npm_config_user_agent?.startsWith(manager) ? 1 : -1;
});
const lockfileNames = lockfileFormats.map((l) => l.name);
export function getDepHash(config: ResolvedConfig, ssr: boolean): string {
  const lockfilePath = lookupFile(config.root, lockfileNames);
  let content = lockfilePath ? fs.readFileSync(lockfilePath, "utf-8") : "";
  if (lockfilePath) {
    const lockfileName = path.basename(lockfilePath);
    const { checkPatches } = lockfileFormats.find(
      (f) => f.name === lockfileName
    )!;
    if (checkPatches) {
      const fullPath = path.join(path.dirname(lockfilePath), "patches");
      const stat = tryStatSync(fullPath);
      if (stat?.isDirectory()) {
        content += stat.mtimeMs.toString();
      }
    }
  }
  const optimizeDeps = getDepOptimizationConfig(config, ssr);
  content += JSON.stringify(
    {
      mode: process.env.NODE_ENV || config.mode,
      root: config.root,
      resolve: config.resolve,
      buildTarget: config.build.target,
      assetsInclude: config.assetsInclude,
      plugins: config.plugins.map((p) => p.name),
      optimizeDeps: {
        include: optimizeDeps?.include,
        exclude: optimizeDeps?.exclude,
        esbuildOptions: {
          ...optimizeDeps?.esbuildOptions,
          plugins: optimizeDeps?.esbuildOptions?.plugins?.map((p) => p.name),
        },
      },
    },
    (_, value) => {
      if (typeof value === "function" || value instanceof RegExp) {
        return value.toString();
      }
      return value;
    }
  );
  return getHash(content);
}
