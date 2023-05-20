// DELETE
// import { ResolvedConfig } from "../config";
// import { InternalResolveOptions, tryNodeResolve } from "../plugins/resolve";
// import { bareImportRE, createDebugger, createFilter } from "../utils";

// const debug = createDebugger("vite:ssr-external");

// // export function createIsConfiguredAsSsrExternal(
// //   config: ResolvedConfig
// // ): (id: string) => boolean {
// //   const { ssr, root } = config;
// //   const noExternal = ssr?.noExternal;
// //   const noExternalFilter =
// //     noExternal !== "undefined" &&
// //     typeof noExternal !== "boolean" &&
// //     createFilter(undefined, noExternal, { resolve: false });

// //   const resolveOptions: InternalResolveOptions = {
// //     ...config.resolve,
// //     root,
// //     isProduction: false,
// //     isBuild: true,
// //   };

// //   const isExternalizable = (
// //     id: string,
// //     configuredAsExternal?: boolean
// //   ): boolean => {
// //     if (!bareImportRE.test(id) || id.includes("\0")) {
// //       return false;
// //     }
// //     try {
// //       return !!tryNodeResolve(
// //         id,
// //         undefined,
// //         resolveOptions,
// //         ssr?.target === "webworker",
// //         undefined,
// //         true,
// //         true,
// //         !!configuredAsExternal
// //       )?.external;
// //     } catch (e) {
// //       debug?.(
// //         `Failed to node resolve "${id}". Skipping externalizing it by default.`
// //       );
// //       return false;
// //     }
// //   };
// //   return (id: string) => {
// //     const { ssr } = config;
// //     if (ssr) {
// //       if (ssr.external?.includes(id)) {
// //         return true;
// //       }
// //       const pkgName = getNpmPackageName(id);
// //       if (!pkgName) {
// //         return isExternalizable(id);
// //       }
// //       if (ssr.external?.includes(pkgName)) {
// //         return isExternalizable(id, true);
// //       }
// //       if (typeof noExternal === "boolean") {
// //         return !noExternal;
// //       }
// //       if (noExternalFilter && !noExternalFilter(pkgName)) {
// //         return false;
// //       }
// //     }
// //     return isExternalizable(id);
// //   };
// // }

// function getNpmPackageName(importPath: string): string | null {
//   const parts = importPath.split("/");
//   if (parts[0][0] === "@") {
//     if (!parts[1]) return null;
//     return `${parts[0]}/${parts[1]}`;
//   } else {
//     return parts[0];
//   }
// }
