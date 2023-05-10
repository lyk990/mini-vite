import path from "node:path";
import { ResolvedConfig } from "../config";
import {
  cleanUrl,
  getHash,
  joinUrlSegments,
  normalizePath,
  removeLeadingSlash,
} from "../utils";
import type {
  NormalizedOutputOptions,
  PluginContext,
  RenderedChunk,
} from "rollup";
import { FS_PREFIX } from "../constants";
import fs, { promises as fsp } from "node:fs";
import colors from "picocolors";
import * as mrmime from "mrmime";
import { parse as parseUrl } from "node:url";
import MagicString from "magic-string";
import type { Plugin } from "rollup";
import {
  createToImportMetaURLBasedRelativeRuntime,
  toOutputFilePathInJS,
} from "../build";

export const assetUrlRE = /__VITE_ASSET__([a-z\d]+)__(?:\$_(.*?)__)?/g;
export const publicAssetUrlRE = /__VITE_PUBLIC_ASSET__([a-z\d]{8})__/g;

export interface GeneratedAssetMeta {
  originalName: string;
  isEntry?: boolean;
}

export const generatedAssets = new WeakMap<
  ResolvedConfig,
  Map<string, GeneratedAssetMeta>
>();

export const publicAssetUrlCache = new WeakMap<
  ResolvedConfig,
  Map<string, string>
>();
const assetCache = new WeakMap<ResolvedConfig, Map<string, string>>();

export function checkPublicFile(
  url: string,
  { publicDir }: ResolvedConfig
): string | undefined {
  if (!publicDir || url[0] !== "/") {
    return;
  }
  const publicFile = path.join(publicDir, cleanUrl(url));
  if (!publicFile.startsWith(publicDir)) {
    return;
  }
  if (fs.existsSync(publicFile)) {
    return publicFile;
  } else {
    return;
  }
}

const rawRE = /(?:\?|&)raw(?:&|$)/;
const urlRE = /(\?|&)url(?:&|$)/;
const jsSourceMapRE = /\.[cm]?js\.map$/;
const unnededFinalQueryCharRE = /[?&]$/;

export function publicFileToBuiltUrl(
  url: string,
  config: ResolvedConfig
): string {
  if (config.command !== "build") {
    return joinUrlSegments(config.base, url);
  }
  const hash = getHash(url);
  let cache = publicAssetUrlCache.get(config);
  if (!cache) {
    cache = new Map<string, string>();
    publicAssetUrlCache.set(config, cache);
  }
  if (!cache.get(hash)) {
    cache.set(hash, url);
  }
  return `__VITE_PUBLIC_ASSET__${hash}__`;
}

export async function fileToUrl(
  id: string,
  config: ResolvedConfig,
  ctx: PluginContext
): Promise<string> {
  if (config.command === "serve") {
    return fileToDevUrl(id, config);
  } else {
    return fileToBuiltUrl(id, config, ctx);
  }
}

function fileToDevUrl(id: string, config: ResolvedConfig) {
  let rtn: string;
  if (checkPublicFile(id, config)) {
    rtn = id;
  } else if (id.startsWith(config.root)) {
    rtn = "/" + path.posix.relative(config.root, id);
  } else {
    rtn = path.posix.join(FS_PREFIX, id);
  }
  const base = joinUrlSegments(config.server?.origin ?? "", config.base);
  return joinUrlSegments(base, removeLeadingSlash(rtn));
}

async function fileToBuiltUrl(
  id: string,
  config: ResolvedConfig,
  pluginContext: PluginContext,
  skipPublicCheck = false
): Promise<string> {
  if (!skipPublicCheck && checkPublicFile(id, config)) {
    return publicFileToBuiltUrl(id, config);
  }

  const cache = assetCache.get(config)!;
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }

  const file = cleanUrl(id);
  const content = await fsp.readFile(file);

  let url: string;
  if (
    config.build.lib ||
    (!file.endsWith(".svg") &&
      !file.endsWith(".html") &&
      content.length < Number(config.build.assetsInlineLimit) &&
      !isGitLfsPlaceholder(content))
  ) {
    if (config.build.lib && isGitLfsPlaceholder(content)) {
      config.logger.warn(
        colors.yellow(`Inlined file ${id} was not downloaded via Git LFS`)
      );
    }

    const mimeType = mrmime.lookup(file) ?? "application/octet-stream";
    url = `data:${mimeType};base64,${content.toString("base64")}`;
  } else {
    const { search, hash } = parseUrl(id);
    const postfix = (search || "") + (hash || "");

    const referenceId = pluginContext.emitFile({
      name: path.basename(file),
      type: "asset",
      source: content,
    });

    const originalName = normalizePath(path.relative(config.root, file));
    generatedAssets.get(config)!.set(referenceId, { originalName });

    url = `__VITE_ASSET__${referenceId}__${postfix ? `$_${postfix}__` : ``}`; // TODO_BASE
  }

  cache.set(id, url);
  return url;
}

const GIT_LFS_PREFIX = Buffer.from("version https://git-lfs.github.com");
function isGitLfsPlaceholder(content: Buffer): boolean {
  if (content.length < GIT_LFS_PREFIX.length) return false;
  return GIT_LFS_PREFIX.compare(content, 0, GIT_LFS_PREFIX.length) === 0;
}

export function assetPlugin(config: ResolvedConfig): Plugin {
  registerCustomMime();

  return {
    name: "vite:asset",

    buildStart() {
      assetCache.set(config, new Map());
      generatedAssets.set(config, new Map());
    },

    resolveId(id) {
      if (!config.assetsInclude(cleanUrl(id))) {
        return;
      }
      const publicFile = checkPublicFile(id, config);
      if (publicFile) {
        return id;
      }
    },

    async load(id) {
      if (id[0] === "\0") {
        return;
      }

      // raw requests, read from disk
      if (rawRE.test(id)) {
        const file = checkPublicFile(id, config) || cleanUrl(id);
        return `export default ${JSON.stringify(
          await fsp.readFile(file, "utf-8")
        )}`;
      }

      if (!config.assetsInclude(cleanUrl(id)) && !urlRE.test(id)) {
        return;
      }

      id = id.replace(urlRE, "$1").replace(unnededFinalQueryCharRE, "");
      const url = await fileToUrl(id, config, this);
      return `export default ${JSON.stringify(url)}`;
    },

    renderChunk(code, chunk, opts) {
      const s = renderAssetUrlInJS(this, config, chunk, opts, code);

      if (s) {
        return {
          code: s.toString(),
          map: config.build.sourcemap ? s.generateMap({ hires: true }) : null,
        };
      } else {
        return null;
      }
    },

    generateBundle(_, bundle) {
      if (
        config.command === "build" &&
        config.build.ssr &&
        !config.build.ssrEmitAssets
      ) {
        for (const file in bundle) {
          if (
            bundle[file].type === "asset" &&
            !file.endsWith("ssr-manifest.json") &&
            !jsSourceMapRE.test(file)
          ) {
            delete bundle[file];
          }
        }
      }
    },
  };
}

export function registerCustomMime(): void {
  mrmime.mimes["ico"] = "image/x-icon";
  mrmime.mimes["flac"] = "audio/flac";
  mrmime.mimes["aac"] = "audio/aac";
  mrmime.mimes["opus"] = "audio/ogg";
  mrmime.mimes["eot"] = "application/vnd.ms-fontobject";
}

export function renderAssetUrlInJS(
  ctx: PluginContext,
  config: ResolvedConfig,
  chunk: RenderedChunk,
  opts: NormalizedOutputOptions,
  code: string
): MagicString | undefined {
  const toRelativeRuntime = createToImportMetaURLBasedRelativeRuntime(
    opts.format,
    false
  );

  let match: RegExpExecArray | null;
  let s: MagicString | undefined;

  assetUrlRE.lastIndex = 0;
  while ((match = assetUrlRE.exec(code))) {
    s ||= new MagicString(code);
    const [full, referenceId, postfix = ""] = match;
    const file = ctx.getFileName(referenceId);
    chunk.viteMetadata!.importedAssets.add(cleanUrl(file));
    const filename = file + postfix;
    const replacement = toOutputFilePathInJS(
      filename,
      "asset",
      chunk.fileName,
      "js",
      config,
      toRelativeRuntime
    );
    const replacementString =
      typeof replacement === "string"
        ? JSON.stringify(replacement).slice(1, -1)
        : `"+${replacement.runtime}+"`;
    s.update(match.index, match.index + full.length, replacementString);
  }

  const publicAssetUrlMap = publicAssetUrlCache.get(config)!;
  publicAssetUrlRE.lastIndex = 0;
  while ((match = publicAssetUrlRE.exec(code))) {
    s ||= new MagicString(code);
    const [full, hash] = match;
    const publicUrl = publicAssetUrlMap.get(hash)!.slice(1);
    const replacement = toOutputFilePathInJS(
      publicUrl,
      "public",
      chunk.fileName,
      "js",
      config,
      toRelativeRuntime
    );
    const replacementString =
      typeof replacement === "string"
        ? JSON.stringify(replacement).slice(1, -1)
        : `"+${replacement.runtime}+"`;
    s.update(match.index, match.index + full.length, replacementString);
  }

  return s;
}
