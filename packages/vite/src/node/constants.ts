import path from "path";
import { readFileSync } from 'node:fs'

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
];

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url)).toString(),
)
export const BARE_IMPORT_RE = /^[\w@][^:]/;
export const PRE_BUNDLE_DIR = path.join("node_modules", ".m-vite");
export const DEFAULT_DEV_PORT = 5173
export const VERSION = version as string