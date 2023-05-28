import { DepOptimizationProcessing, transformWithEsbuild } from "vite";
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
export { getDepsOptimizer } from "./optimizer";
import { promisify } from "node:util";
import esbuild, { build } from "esbuild";
import { ESBUILD_MODULES_TARGET } from "../constants";
// import { esbuildDepPlugin } from "./esbuildDepPlugin ";
import type {
  BuildContext,
  BuildOptions as EsbuildBuildOptions,
} from "esbuild";
import colors from 'picocolors'

const debug = createDebugger("vite:deps");

const jsExtensionRE = /\.js$/i;
const jsMapExtensionRE = /\.js\.map$/i;

export interface DepOptimizationResult {
  metadata: DepOptimizationMetadata;
  commit: () => Promise<void>;
  cancel: () => void;
}

export interface DepOptimizationMetadata {
  hash: string;
  browserHash: string;
  optimized: Record<string, OptimizedDepInfo>;
  chunks: Record<string, OptimizedDepInfo>;
  discovered: Record<string, OptimizedDepInfo>;
  depInfoList: OptimizedDepInfo[];
}

export interface DepsOptimizer {
  metadata: DepOptimizationMetadata;
  scanProcessing?: Promise<void>;
  registerMissingImport: (id: string, resolved: string) => OptimizedDepInfo;
  run: () => void;
  isOptimizedDepFile: (id: string) => boolean;
  isOptimizedDepUrl: (url: string) => boolean;
  getOptimizedDepId: (depInfo: OptimizedDepInfo) => string;
  delayDepsOptimizerUntil: (id: string, done: () => Promise<any>) => void;
  registerWorkersSource: (id: string) => void;
  resetRegisteredIds: () => void;
  ensureFirstRun: () => void;
  close: () => Promise<void>;
  options: DepOptimizationOptions;
}

export type DepOptimizationOptions = DepOptimizationConfig & {
  entries?: string | string[];
  force?: boolean;
};

export interface DepOptimizationConfig {
  include?: string[];
  exclude?: string[];
  needsInterop?: string[];
  esbuildOptions?: Omit<
    EsbuildBuildOptions,
    | "bundle"
    | "entryPoints"
    | "external"
    | "write"
    | "watch"
    | "outdir"
    | "outfile"
    | "outbase"
    | "outExtension"
    | "metafile"
  >;
  extensions?: string[];
  disabled?: boolean | "build" | "dev";
  noDiscovery?: boolean;
}

export interface OptimizedDepInfo {
  id: string;
  file: string;
  src?: string;
  needsInterop?: boolean;
  browserHash?: string;
  fileHash?: string;
  processing?: Promise<void>;
  exportsData?: Promise<ExportsData>;
}

export type ExportsData = {
  hasImports: boolean;
  exports: readonly string[];
  jsxLoader?: boolean;
};

export interface OptimizedDepInfo {
  id: string;
  file: string;
  src?: string;
  needsInterop?: boolean;
  browserHash?: string;
  fileHash?: string;
  processing?: Promise<void>;
  exportsData?: Promise<ExportsData>;
}

/**查看预构建依赖缓存 */
export async function loadCachedDepOptimizationMetadata(
  config: ResolvedConfig,
  // ssr: boolean = false
): Promise<DepOptimizationMetadata | undefined> {
  const depsCacheDir = getDepsCacheDir(config);
  let cachedMetadata: DepOptimizationMetadata | undefined;
  try {
    // 首次进行依赖预构建时并没有_metadata.json文件，所以会报错，这里捕获错误
    // 但不进行处理，因为这是正常的,直接走下面的逻辑
    const cachedMetadataPath = path.join(depsCacheDir, "_metadata.json");
    cachedMetadata = parseDepsOptimizerMetadata(
      await fsp.readFile(cachedMetadataPath, "utf-8"),
      depsCacheDir
    );
  } catch (e) {
    // entry point
  }
  // 比较hash是否一直来判断需不需要重复预构建依赖
  if (cachedMetadata && cachedMetadata.hash === getDepHash(config)) {
    return cachedMetadata;
  }
  // 删除预构建依赖文件(deps)和目录
  await fsp.rm(depsCacheDir, { recursive: true, force: true });
}
/**获取deps文件的路径 */
export function getDepsCacheDir(config: ResolvedConfig): string {
  return getDepsCacheDirPrefix(config) + getDepsCacheSuffix();
}
/**解析_metadat.json内容 */
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
  // if (
  //   !chunks ||
  //   Object.values(optimized).some((depInfo: any) => !depInfo.fileHash)
  // ) {
  //   return;
  // }
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

/**查找node_modules中的依赖 */
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
        throw new Error(
          `The following dependencies are imported but could not be resolved:\n\n  ${missingIds
            .map(
              (id) =>
                `${colors.cyan(id)} ${colors.white(
                  colors.dim(`(imported by ${missing[id]})`)
                )}`
            )
            .join(`\n  `)}\n\nAre they installed?`
        );
      }
      return deps;
    }),
  };
}

export function optimizedDepInfoFromFile(
  metadata: DepOptimizationMetadata,
  file: string
): OptimizedDepInfo | undefined {
  return metadata.depInfoList.find((depInfo) => depInfo.file === file);
}
/**将esbuild扫描后的依赖放入node_moudles/.vite中 */
export function runOptimizeDeps(
  resolvedConfig: ResolvedConfig,
  depsInfo: Record<string, OptimizedDepInfo>,
  // ssr: boolean = false
): {
  cancel: () => Promise<void>;
  result: Promise<DepOptimizationResult>;
} {
  const optimizerContext = { cancelled: false };

  const config: ResolvedConfig = {
    ...resolvedConfig,
    command: "build",
  };

  const depsCacheDir = getDepsCacheDir(resolvedConfig);
  const processingCacheDir = getProcessingDepsCacheDir(resolvedConfig);

  fs.mkdirSync(processingCacheDir, { recursive: true });

  fs.writeFileSync(
    path.resolve(processingCacheDir, "package.json"),
    `{\n  "type": "module"\n}\n`
  );

  const metadata = initDepsOptimizerMetadata(config);

  metadata.browserHash = getOptimizedBrowserHash(
    metadata.hash,
    depsFromOptimizedDepInfo(depsInfo)
  );

  // const qualifiedIds = Object.keys(depsInfo); DELETE
  const cleanUp = () => {
    fsp
      .rm(processingCacheDir, { recursive: true, force: true })
      .catch((e) => {});
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
  //  DELETE 没有依赖
  // if (!qualifiedIds.length) {
  //   return {
  //     cancel: async () => cleanUp(),
  //     result: Promise.resolve(succesfulResult),
  //   };
  // }

  const cancelledResult: DepOptimizationResult = {
    metadata,
    commit: async () => cleanUp(),
    cancel: cleanUp,
  };

  // const start = performance.now();

  const preparedRun = prepareEsbuildOptimizerRun(
    resolvedConfig,
    depsInfo,
    // ssr,
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
            fileHash: getHash(
              metadata.hash + depsInfo[id].file + JSON.stringify(output.imports)
            ),
            browserHash: metadata.browserHash,
            needsInterop: needsInterop(config, id, idToExports[id], output),
          });
        }

        for (const o of Object.keys(meta.outputs)) {
          if (!o.match(jsMapExtensionRE)) {
            const id = path
              .relative(processingCacheDirOutputPath, o)
              .replace(jsExtensionRE, "");
            const file = getOptimizedDepPath(id, resolvedConfig);
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

        // debug?.(
        //   `Dependencies bundled in ${(performance.now() - start).toFixed(2)}ms`
        // );

        return succesfulResult;
      })

      .catch((e) => {
        if (e.errors && e.message.includes("The build was canceled")) {
          return cancelledResult;
        }
        throw e;
      })
      .finally(() => {
        return disposeContext();
      });
  });

  runResult.catch((e) => {
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

function getProcessingDepsCacheDir(config: ResolvedConfig) {
  return getDepsCacheDirPrefix(config) + getDepsCacheSuffix() + getTempSuffix();
}
function getDepsCacheDirPrefix(config: ResolvedConfig): string {
  return normalizePath(path.resolve(config.cacheDir, "deps"));
}

// TODO  getDepsCacheSuffix 是否直接返回""
function getDepsCacheSuffix(): string {
  let suffix = "";
  // if (config.command === "build") {
  //   const { outDir } = config.build;
  //   const buildId =
  //     outDir.length > 8 || outDir.includes("/") ? getHash(outDir) : outDir;
  //   suffix += `_build-${buildId}`;
  // }
  // if (ssr) {
  //   suffix += "_ssr";
  // }
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
/**esbuild打包初始化 */
async function prepareEsbuildOptimizerRun(
  resolvedConfig: ResolvedConfig,
  depsInfo: Record<string, OptimizedDepInfo>,
  // ssr: boolean,
  processingCacheDir: string,
  optimizerContext: { cancelled: boolean }
): Promise<{
  context?: BuildContext;
  idToExports: Record<string, ExportsData>;
}> {
  // const isBuild = resolvedConfig.command === "build";
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
        extractExportsData(src, config));
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
    "process.env.NODE_ENV":
      // isBuild
      //   ? "__vite_process_env_NODE_ENV"
      //   :
      JSON.stringify(process.env.NODE_ENV || config.mode),
  };

  // const platform =
  //   ssr && config.ssr?.target !== "webworker" ? "node" : "browser";

  const external = [...(optimizeDeps?.exclude ?? [])];
  const plugins = [...pluginsFromConfig];
  // plugins.push(esbuildDepPlugin(flatIdDeps, external, config));
  // 扫描依赖
  const context = await esbuild.context({
    absWorkingDir: process.cwd(),
    entryPoints: Object.keys(flatIdDeps),
    bundle: true, // 递归扫描依赖
    platform: "browser",
    define,
    format: "esm",
    banner: undefined,
    // platform === "node"
    //   ? {
    //       js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`,
    //     }
    //   : undefined,
    // isBuild ? config.build.target || undefined :
    target: ESBUILD_MODULES_TARGET,
    external,
    logLevel: "error",
    splitting: true,
    sourcemap: true,
    outdir: processingCacheDir,
    ignoreAnnotations: true,
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

export function initDepsOptimizerMetadata(
  config: ResolvedConfig,
  timestamp?: string
): DepOptimizationMetadata {
  const hash = getDepHash(config);
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
  config: ResolvedConfig
): string {
  return normalizePath(
    path.resolve(getDepsCacheDir(config), flattenId(id) + ".js")
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
  config: ResolvedConfig
  // ssr: boolean
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
  } catch (e) {
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
/** NOTE: 帮助解析模块，生成互操作代码，确保模块之间的交互能正常进行 */
function needsInterop(
  config: ResolvedConfig,
  id: string,
  exportsData: ExportsData,
  output?: { exports: string[] }
): boolean {
  if (getDepOptimizationConfig(config)?.needsInterop?.includes(id)) {
    return true;
  }
  const { hasImports, exports } = exportsData;
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
  { name: "yarn.lock", checkPatches: true, manager: "yarn" },
  { name: "pnpm-lock.yaml", checkPatches: false, manager: "pnpm" },
  { name: "bun.lockb", checkPatches: true, manager: "bun" },
].sort((_, { manager }) => {
  return process.env.npm_config_user_agent?.startsWith(manager) ? 1 : -1;
});
const lockfileNames = lockfileFormats.map((l) => l.name);

export function getDepHash(config: ResolvedConfig): string {
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

  const optimizeDeps = getDepOptimizationConfig(config);
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

// export function optimizedDepInfoFromId(
//   metadata: DepOptimizationMetadata,
//   id: string
// ): OptimizedDepInfo | undefined {
//   return (
//     metadata.optimized[id] || metadata.discovered[id] || metadata.chunks[id]
//   );
// }

// export async function optimizedDepNeedsInterop(
//   metadata: DepOptimizationMetadata,
//   file: string,
//   config: ResolvedConfig
// ): Promise<boolean | undefined> {
//   const depInfo = optimizedDepInfoFromFile(metadata, file);
//   if (depInfo?.src && depInfo.needsInterop === undefined) {
//     depInfo.exportsData ??= extractExportsData(depInfo.src, config);
//     depInfo.needsInterop = needsInterop(
//       config,
//       depInfo.id,
//       await depInfo.exportsData
//     );
//   }
//   return depInfo?.needsInterop;
// }
