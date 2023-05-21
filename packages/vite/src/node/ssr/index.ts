// import type { DepOptimizationConfig } from "../optimizer";

// export type SSRTarget = "node" | "webworker";
// export type SSRFormat = "esm" | "cjs";

// export type SsrDepOptimizationOptions = DepOptimizationConfig;

// export interface SSROptions {
//   noExternal?: string | RegExp | (string | RegExp)[] | true;
//   external?: string[];
//   target?: SSRTarget;
//   format?: SSRFormat;
//   optimizeDeps?: SsrDepOptimizationOptions;
// }

// DELETE
// export interface ResolvedSSROptions extends SSROptions {
//   target: SSRTarget;
//   format: SSRFormat;
//   optimizeDeps: SsrDepOptimizationOptions;
// }

// export function resolveSSROptions(
//   ssr: SSROptions | undefined,
//   preserveSymlinks: boolean,
//   buildSsrCjsExternalHeuristics?: boolean
// ): ResolvedSSROptions {
//   ssr ??= {};
//   const optimizeDeps = ssr.optimizeDeps ?? {};
//   let format: SSRFormat = "esm";
//   let target: SSRTarget = "node";
//   if (buildSsrCjsExternalHeuristics) {
//     if (ssr) {
//       format = "cjs";
//     } else {
//       target = "node";
//       format = "cjs";
//     }
//   }
//   return {
//     format,
//     target,
//     ...ssr,
//     optimizeDeps: {
//       disabled: true,
//       ...optimizeDeps,
//       esbuildOptions: {
//         preserveSymlinks,
//         ...optimizeDeps.esbuildOptions,
//       },
//     },
//   };
// }
