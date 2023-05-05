import { readFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url)).toString()
);
export const CSS_LANGS_RE =
  /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;
export const BARE_IMPORT_RE = /^[\w@][^:]/;
export const PRE_BUNDLE_DIR = path.join("node_modules", ".m-vite");
export const DEFAULT_DEV_PORT = 5173;
export const VERSION = version as string;
export const VITE_PACKAGE_DIR = resolve(
  // import.meta.url is `dist/node/constants.js` after bundle
  fileURLToPath(import.meta.url),
  "../../.."
);
export const CLIENT_ENTRY = resolve(VITE_PACKAGE_DIR, "dist/client/client.mjs");
export const CLIENT_DIR = path.dirname(CLIENT_ENTRY);

export const DEFAULT_MAIN_FIELDS = [
  "module",
  "jsnext:main", // moment still uses this...
  "jsnext",
];
export const DEFAULT_EXTENSIONS = [
  ".mjs",
  ".js",
  ".mts",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
];
export const EXTERNAL_TYPES = [
  "css",
  "less",
  "sass",
  "scss",
  "styl",
  "stylus",
  "pcss",
  "postcss",
  "vue",
  "svelte",
  "marko",
  "astro",
  "png",
  "jpe?g",
  "gif",
  "svg",
  "ico",
  "webp",
  "avif",
  // EXTERNAL_TYPES
  "html",
  "vue",
  "svelte",
  "astro",
  "imba",
  "ts",
];
export const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/;

export const FS_PREFIX = `/@fs/`;

export const VALID_ID_PREFIX = `/@id/`;
export const NULL_BYTE_PLACEHOLDER = `__x00__`;
export const CLIENT_PUBLIC_PATH = `/@vite/client`;

export const DEFAULT_CONFIG_FILES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];
