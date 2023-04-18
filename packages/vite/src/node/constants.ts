import path from "path";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url)).toString()
);
export const BARE_IMPORT_RE = /^[\w@][^:]/;
export const PRE_BUNDLE_DIR = path.join("node_modules", ".m-vite");
export const DEFAULT_DEV_PORT = 5173;
export const VERSION = version as string;
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
  'html',
  'vue',
  'svelte',
  'astro',
  'imba',
  'ts',
];
export const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/
