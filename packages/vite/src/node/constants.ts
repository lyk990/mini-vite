import path from "path";

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

export const BARE_IMPORT_RE = /^[\w@][^:]/;
export const PRE_BUNDLE_DIR = path.join("node_modules", ".m-vite");
