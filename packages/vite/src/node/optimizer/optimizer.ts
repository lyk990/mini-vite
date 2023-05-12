import { ResolvedConfig } from "../config";
import { ViteDevServer } from "../server";
import { getHash } from "../utils";
import {
  loadCachedDepOptimizationMetadata,
  discoverProjectDependencies,
  runOptimizeDeps,
  initDepsOptimizerMetadata,
  getOptimizedDepPath,
  depsFromOptimizedDepInfo,
  newDepOptimizationProcessing,
  extractExportsData,
  addOptimizedDepInfo,
  OptimizedDepInfo,
  DepsOptimizer,
} from "./index";

const depsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>();
const devSsrDepsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>();

export function getDepsOptimizer(
  config: ResolvedConfig,
  ssr?: boolean
): DepsOptimizer | undefined {
  const isDevSsr = false;
  return (isDevSsr ? devSsrDepsOptimizerMap : depsOptimizerMap).get(config);
}

/**预构建依赖 */
export async function initDepsOptimizer(
  config: ResolvedConfig,
  server?: ViteDevServer
): Promise<void> {
  await createDepsOptimizer(config, server);
}

async function createDepsOptimizer(
  config: ResolvedConfig,
  server?: ViteDevServer
): Promise<void> {
  const sessionTimestamp = Date.now().toString();
  let ssr = false;
  const cachedMetadata = await loadCachedDepOptimizationMetadata(config, false);
  let metadata =
    cachedMetadata ||
    initDepsOptimizerMetadata(config, false, sessionTimestamp);
  let depOptimizationProcessing = newDepOptimizationProcessing();

  let discover;
  if (!cachedMetadata) {
    discover = discoverProjectDependencies(config);
    const deps = await discover.result;
    discover = undefined;
    for (const id of Object.keys(deps)) {
      addMissingDep(id, deps[id]);
    }

    const knownDeps = prepareKnownDeps();
    runOptimizeDeps(config, knownDeps);
  }

  function addMissingDep(id: string, resolved: string) {
    return addOptimizedDepInfo(metadata, "discovered", {
      id,
      file: getOptimizedDepPath(id, config, ssr),
      src: resolved,
      browserHash: getDiscoveredBrowserHash(
        metadata.hash,
        depsFromOptimizedDepInfo(metadata.optimized),
        depsFromOptimizedDepInfo(metadata.discovered)
      ),
      processing: depOptimizationProcessing.promise,
      exportsData: extractExportsData(resolved, config, ssr),
    });
  }

  function prepareKnownDeps() {
    const knownDeps: Record<string, OptimizedDepInfo> = {};
    for (const dep of Object.keys(metadata.optimized)) {
      knownDeps[dep] = { ...metadata.optimized[dep] };
    }
    for (const dep of Object.keys(metadata.discovered)) {
      const { processing, ...info } = metadata.discovered[dep];
      knownDeps[dep] = info;
    }
    return knownDeps;
  }

  function getDiscoveredBrowserHash(
    hash: string,
    deps: Record<string, string>,
    missing: Record<string, string>
  ) {
    return getHash(
      hash + JSON.stringify(deps) + JSON.stringify(missing) + sessionTimestamp
    );
  }
}
