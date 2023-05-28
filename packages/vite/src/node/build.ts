import path from "node:path";
import { BuildOptions, ResolvedBuildOptions } from "vite";
// import { Logger } from "./logger";
import type { InternalModuleFormat } from "rollup";
// import { joinUrlSegments } from "./utils";
// import { ResolvedConfig } from "./config";

export function resolveBuildOptions(
  raw: BuildOptions | undefined
  // logger: Logger,
  // root: string
): ResolvedBuildOptions {
  const defaultBuildOptions: BuildOptions = {
    outDir: "dist",
    assetsDir: "assets",
    assetsInlineLimit: 4096,
    cssCodeSplit: !raw?.lib,
    sourcemap: false,
    rollupOptions: {},
    minify: "esbuild",
    terserOptions: {},
    write: true,
    emptyOutDir: null,
    copyPublicDir: true,
    manifest: false,
    lib: false,
    // ssr: false,
    ssrManifest: false,
    ssrEmitAssets: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 500,
    watch: null,
  };
  const userBuildOptions = defaultBuildOptions;
  // const modulePreload = raw?.modulePreload;
  const defaultModulePreload = {
    polyfill: true,
  };
  // @ts-expect-error Fallback options instead of merging
  const resolved: ResolvedBuildOptions = {
    target: "modules",
    cssTarget: false,
    ...userBuildOptions,
    commonjsOptions: {
      include: [/node_modules/],
      extensions: [".js", ".cjs"],
      ...userBuildOptions.commonjsOptions,
    },
    dynamicImportVarsOptions: {
      warnOnError: true,
      exclude: [/node_modules/],
      ...userBuildOptions.dynamicImportVarsOptions,
    },
    modulePreload:
      // modulePreload === false
      //   ? false
      //   : typeof modulePreload === "object"
      //   ? {
      //       ...defaultModulePreload,
      //       ...modulePreload,
      //     }
      //   :
      defaultModulePreload,
  };

  return resolved;
}

const getResolveUrl = (path: string, URL = "URL") => `new ${URL}(${path}).href`;
const getFileUrlFromFullPath = (path: string) =>
  `require('u' + 'rl').pathToFileURL(${path}).href`;

const getFileUrlFromRelativePath = (path: string) =>
  getFileUrlFromFullPath(`__dirname + '/${path}'`);

const getRelativeUrlFromDocument = (relativePath: string, umd = false) =>
  getResolveUrl(
    `'${escapeId(relativePath)}', ${
      umd ? `typeof document === 'undefined' ? location.href : ` : ""
    }document.currentScript && document.currentScript.src || document.baseURI`
  );

const needsEscapeRegEx = /[\n\r'\\\u2028\u2029]/;
const quoteNewlineRegEx = /([\n\r'\u2028\u2029])/g;
const backSlashRegEx = /\\/g;
function escapeId(id: string): string {
  if (!needsEscapeRegEx.test(id)) return id;
  return id.replace(backSlashRegEx, "\\\\").replace(quoteNewlineRegEx, "\\$1");
}

const relativeUrlMechanisms: Record<
  InternalModuleFormat,
  (relativePath: string) => string
> = {
  amd: (relativePath) => {
    if (relativePath[0] !== ".") relativePath = "./" + relativePath;
    return getResolveUrl(`require.toUrl('${relativePath}'), document.baseURI`);
  },
  cjs: (relativePath) =>
    `(typeof document === 'undefined' ? ${getFileUrlFromRelativePath(
      relativePath
    )} : ${getRelativeUrlFromDocument(relativePath)})`,
  es: (relativePath) => getResolveUrl(`'${relativePath}', import.meta.url`),
  iife: (relativePath) => getRelativeUrlFromDocument(relativePath),
  system: (relativePath) => getResolveUrl(`'${relativePath}', module.meta.url`),
  umd: (relativePath) =>
    `(typeof document === 'undefined' && typeof location === 'undefined' ? ${getFileUrlFromRelativePath(
      relativePath
    )} : ${getRelativeUrlFromDocument(relativePath, true)})`,
};

const customRelativeUrlMechanisms = {
  ...relativeUrlMechanisms,
  "worker-iife": (relativePath) =>
    getResolveUrl(`'${relativePath}', self.location.href`),
} as const satisfies Record<string, (relativePath: string) => string>;

export function createToImportMetaURLBasedRelativeRuntime(
  format: InternalModuleFormat
  // isWorker: boolean
): (filename: string, importer: string) => { runtime: string } {
  const formatLong = format;
  const toRelativePath = customRelativeUrlMechanisms[formatLong];
  return (filename, importer) => ({
    runtime: toRelativePath(
      path.posix.relative(path.dirname(importer), filename)
    ),
  });
}

// export function toOutputFilePathInJS(
//   filename: string,
//   type: "asset" | "public",
//   hostId: string,
//   hostType: "js" | "css" | "html",
//   config: ResolvedConfig,
//   toRelative: (
//     filename: string,
//     hostType: string
//   ) => string | { runtime: string }
// ): string | { runtime: string } {
//   const { renderBuiltUrl } = config.experimental;
//   let relative = config.base === "" || config.base === "./";
//   if (renderBuiltUrl) {
//     const result = renderBuiltUrl(filename, {
//       hostId,
//       hostType,
//       type,
//       ssr: !!config.build.ssr,
//     });
//     if (typeof result === "object") {
//       if (result.runtime) {
//         return { runtime: result.runtime };
//       }
//       if (typeof result.relative === "boolean") {
//         relative = result.relative;
//       }
//     } else if (result) {
//       return result;
//     }
//   }
//   if (relative && !config.build.ssr) {
//     return toRelative(filename, hostId);
//   }
//   return joinUrlSegments(config.base, filename);
// }

// export function resolveUserExternal(
//   user: ExternalOption,
//   id: string,
//   parentId: string | undefined,
//   isResolved: boolean
// ): boolean | null | void {
//   if (typeof user === "function") {
//     return user(id, parentId, isResolved);
//   } else if (Array.isArray(user)) {
//     return user.some((test) => isExternal(id, test));
//   } else {
//     return isExternal(id, user);
//   }
// }

// function isExternal(id: string, test: string | RegExp) {
//   if (typeof test === "string") {
//     return id === test;
//   } else {
//     return test.test(id);
//   }
// }

// export function toOutputFilePathWithoutRuntime(
//   filename: string,
//   type: "asset" | "public",
//   hostId: string,
//   hostType: "js" | "css" | "html",
//   config: ResolvedConfig,
//   toRelative: (filename: string, hostId: string) => string
// ): string {
//   const { renderBuiltUrl } = config.experimental;
//   let relative = config.base === "" || config.base === "./";
//   if (renderBuiltUrl) {
//     const result = renderBuiltUrl(filename, {
//       hostId,
//       hostType,
//       type,
//       ssr: !!config.build.ssr,
//     });
//     if (typeof result === "object") {
//       if (result.runtime) {
//         throw new Error(
//           `{ runtime: "${result.runtime}" } is not supported for assets in ${hostType} files: ${filename}`
//         );
//       }
//       if (typeof result.relative === "boolean") {
//         relative = result.relative;
//       }
//     } else if (result) {
//       return result;
//     }
//   }
//   if (relative && !config.build.ssr) {
//     return toRelative(filename, hostId);
//   } else {
//     return joinUrlSegments(config.base, filename);
//   }
// }
// export const toOutputFilePathInCss = toOutputFilePathWithoutRuntime;
