import { ResolvedConfig } from "../config";
import { getHash } from "../utils";
import {
  loadCachedDepOptimizationMetadata,
  discoverProjectDependencies,
  runOptimizeDeps,
  initDepsOptimizerMetadata,
  getOptimizedDepPath,
  depsFromOptimizedDepInfo,
  extractExportsData,
  addOptimizedDepInfo,
  OptimizedDepInfo,
} from "./index";

/**初始化预构建依赖 */
export async function initDepsOptimizer(config: ResolvedConfig): Promise<void> {
  await createDepsOptimizer(config);
}

async function createDepsOptimizer(config: ResolvedConfig): Promise<void> {
  const sessionTimestamp = Date.now().toString();
  const cachedMetadata = await loadCachedDepOptimizationMetadata(config);
  // 有缓存的话，就直接使用缓存的metadata，否则就初始化metadata
  let metadata =
    cachedMetadata || initDepsOptimizerMetadata(config, sessionTimestamp);

  let discover;
  if (!cachedMetadata) {
    // 扫描node_modules中的依赖
    discover = discoverProjectDependencies(config);
    const deps = await discover.result;
    discover = undefined;
    for (const id of Object.keys(deps)) {
      addMissingDep(id, deps[id]);
    }

    const knownDeps = prepareKnownDeps();
    // 将依赖信息写入metadata.json文件中
    (await runOptimizeDeps(config, knownDeps).result).commit();
  }
  /**
   * 在编写代码时可能会忽略某些依赖项的引入，
   * 或者某些依赖项的引入被误删或错误修改。
   * addMissingDep 函数的作用就是检测模块中缺失的依赖项，
   * 并自动向模块添加这些缺失的依赖项。
   * */
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
      exportsData: extractExportsData(resolved, config),
    });
  }
  /**将依赖项处理成所需要的结构 */
  function prepareKnownDeps() {
    const knownDeps: Record<string, OptimizedDepInfo> = {};
    for (const dep of Object.keys(metadata.optimized)) {
      knownDeps[dep] = { ...metadata.optimized[dep] };
    }
    for (const dep of Object.keys(metadata.discovered)) {
      const { ...info } = metadata.discovered[dep];
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
