import path from "node:path";
import { BuildOptions, ResolvedBuildOptions } from "vite";
import type { InternalModuleFormat } from "rollup";

export function resolveBuildOptions(
  raw: BuildOptions | undefined
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
    ssrManifest: false,
    ssrEmitAssets: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 500,
    watch: null,
  };
  const userBuildOptions = defaultBuildOptions;
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
    modulePreload: defaultModulePreload,
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
): (filename: string, importer: string) => { runtime: string } {
  const formatLong = format;
  const toRelativePath = customRelativeUrlMechanisms[formatLong];
  return (filename, importer) => ({
    runtime: toRelativePath(
      path.posix.relative(path.dirname(importer), filename)
    ),
  });
}
