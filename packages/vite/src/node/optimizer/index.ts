import type { DepOptimizationMetadata } from "vite";
import { ResolvedConfig } from "../config";
import { ViteDevServer } from "../server";
import { normalizePath } from "../utils";
import path from "node:path";

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
  const { logger } = config;
  const cachedMetadata = await loadCachedDepOptimizationMetadata(config, false);
}

export async function loadCachedDepOptimizationMetadata(
  config: ResolvedConfig,
  ssr: boolean,
  force = config.optimizeDeps.force,
  asCommand = false
): Promise<DepOptimizationMetadata | undefined> {
  const depsCacheDir = getDepsCacheDir(config, ssr);
  return;
}

// TODO
export function getDepsCacheDir(config: ResolvedConfig, ssr: boolean): string {
  return normalizePath(path.resolve("node_modules/.mini-vite", "deps"));
}
