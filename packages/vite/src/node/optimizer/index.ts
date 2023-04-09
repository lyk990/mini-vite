import type { DepOptimizationMetadata, OptimizedDepInfo } from "vite";
import { ResolvedConfig } from "../config";
import { ViteDevServer } from "../server";
import { createDebugger, normalizePath } from "../utils";
import path from "node:path";
import fsp from "node:fs/promises";

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
) {
  const isBuild = false;
  const { logger } = config;
  const cachedMetadata = await loadCachedDepOptimizationMetadata(config, false);
}

// TODO
export async function loadCachedDepOptimizationMetadata(
  config: ResolvedConfig,
  ssr: boolean,
  force = config.optimizeDeps.force,
  asCommand = false
): Promise<DepOptimizationMetadata | undefined> {
  const log = asCommand ? config.logger.info : debug;
  const depsCacheDir = getDepsCacheDir(config, ssr);
  console.log("depsCacheDir", depsCacheDir);
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
      // Nothing to commit or cancel as we are using the cache, we only
      // need to resolve the processing promise so requests can move on
      return cachedMetadata;
    }
  } else {
    config.logger.info("Forced re-optimization of dependencies");
  }
  await fsp.rm(depsCacheDir, { recursive: true, force: true });
}

// TODO
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

// TODO 比较hash
export function getDepHash(config: ResolvedConfig, ssr: boolean): string {
  return "false";
}
