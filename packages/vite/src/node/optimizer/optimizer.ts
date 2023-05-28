import { ResolvedConfig } from "../config";
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
  config: ResolvedConfig
): DepsOptimizer | undefined {
  const isDevSsr = config.command !== "build";
  return (isDevSsr ? devSsrDepsOptimizerMap : depsOptimizerMap).get(
    config.mainConfig || config
  );
}

/**初始化预构建依赖 */
export async function initDepsOptimizer(
  config: ResolvedConfig
): Promise<void> {
  await createDepsOptimizer(config);
}

async function createDepsOptimizer(
  config: ResolvedConfig
): Promise<void> {
  const sessionTimestamp = Date.now().toString();
  const cachedMetadata = await loadCachedDepOptimizationMetadata(config);
  let metadata =
    cachedMetadata || initDepsOptimizerMetadata(config, sessionTimestamp);
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
    //  通过调用runOptimizeDeps方法将依赖信息写入metadata.json文件中
    (await runOptimizeDeps(config, knownDeps).result).commit();
  }

  function addMissingDep(id: string, resolved: string) {
    return addOptimizedDepInfo(metadata, "discovered", {
      id,
      file: getOptimizedDepPath(id, config),
      src: resolved,
      browserHash: getDiscoveredBrowserHash(
        metadata.hash,
        depsFromOptimizedDepInfo(metadata.optimized),
        depsFromOptimizedDepInfo(metadata.discovered)
      ),
      processing: depOptimizationProcessing.promise,
      exportsData: extractExportsData(resolved, config),
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
