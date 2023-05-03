import { DepOptimizationMetadata, DepsOptimizer } from "vite";
import { ResolvedConfig } from "../config";

const depsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>();
const devSsrDepsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>();
export function getDepsOptimizer(
  config: ResolvedConfig,
  ssr?: boolean
): DepsOptimizer | undefined {
  // Workers compilation shares the DepsOptimizer from the main build
  const isDevSsr = false;
  return (isDevSsr ? devSsrDepsOptimizerMap : depsOptimizerMap).get(config);
}
