// import { BuildOptions, ResolvedBuildOptions } from "vite";
// import { Logger } from "./logger";

// export function resolveBuildOptions(
//   raw: BuildOptions | undefined,
//   logger: Logger,
//   root: string
// ): ResolvedBuildOptions {
//   console.log("raw", raw);
//   const defaultBuildOptions: BuildOptions = {
//     outDir: "dist",
//     assetsDir: "assets",
//     assetsInlineLimit: 4096,
//     cssCodeSplit: !raw?.lib,
//     sourcemap: false,
//     rollupOptions: {},
//     minify: raw?.ssr ? false : "esbuild",
//     terserOptions: {},
//     write: true,
//     emptyOutDir: null,
//     copyPublicDir: true,
//     manifest: false,
//     lib: false,
//     ssr: false,
//     ssrManifest: false,
//     ssrEmitAssets: false,
//     reportCompressedSize: true,
//     chunkSizeWarningLimit: 500,
//     watch: null,
//   };
//   const userBuildOptions = defaultBuildOptions;
//   const resolved: ResolvedBuildOptions = {
//     target: "modules",
//     cssTarget: false,
//     ...userBuildOptions,
//     commonjsOptions: {
//       include: [/node_modules/],
//       extensions: [".js", ".cjs"],
//       ...userBuildOptions.commonjsOptions,
//     },
//     dynamicImportVarsOptions: {
//       warnOnError: true,
//       exclude: [/node_modules/],
//       ...userBuildOptions.dynamicImportVarsOptions,
//     },
//     // Resolve to false | object
//     modulePreload:
//       modulePreload === false
//         ? false
//         : typeof modulePreload === "object"
//         ? {
//             ...defaultModulePreload,
//             ...modulePreload,
//           }
//         : defaultModulePreload,
//   };

//   return resolved;
// }
