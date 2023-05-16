export * from "./config";

export type {
  ViteDevServer,
  ResolvedServerOptions,
  ResolvedServerUrls,
} from "./server";

export type {
  AliasOptions,
  MapToFunction,
  ResolverFunction,
  ResolverObject,
  Alias,
} from "dep-types/alias";

export type {
  DepOptimizationMetadata,
  DepOptimizationOptions,
  DepOptimizationConfig,
  DepOptimizationResult,
  OptimizedDepInfo,
  DepsOptimizer,
  ExportsData,
} from "./optimizer";
