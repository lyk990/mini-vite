import type { DepOptimizationMetadata, OptimizedDepInfo } from "vite";
import { ResolvedConfig } from "../config";
import { ViteDevServer } from "../server";
import { createDebugger, normalizePath } from "../utils";
import path from "node:path";
import fsp from "node:fs/promises";
import { scanImports } from "./scan";
import { build } from "esbuild";
import { PRE_BUNDLE_DIR } from "../constants";

const debug = createDebugger("vite:deps");

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
    let deps = await discover.result;
    discover = undefined;
    console.log("deps", deps);
    return;
    // TODO
    // runOptimizeDeps(config, deps);
    // TODO 从小册copy出来的  需要改写
    // const root = normalizePath(process.cwd());
    await build({
      entryPoints: [...deps],
      write: true,
      bundle: true,
      format: "esm",
      splitting: true,
      outdir: path.resolve(root, PRE_BUNDLE_DIR),
      plugins: [preBundlePlugin(deps)],
    });
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

export function runOptimizeDeps(
  resolvedConfig: ResolvedConfig,
  depsInfo: Record<string, OptimizedDepInfo>,
  ssr: boolean = false
): {
  cancel: () => Promise<void>;
  result: Promise<DepOptimizationResult>;
} {}
