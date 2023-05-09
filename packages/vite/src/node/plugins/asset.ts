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
import colors from 'picocolors'
import * as mrmime from 'mrmime'
import { parse as parseUrl } from 'node:url'

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
