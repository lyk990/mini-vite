import path from "node:path";
import { ResolvedConfig } from "../config";
import {
  cleanUrl,
  joinUrlSegments,
  removeLeadingSlash,
} from "../utils";
import type {
  PluginContext,
} from "rollup";
import * as mrmime from "mrmime";
import type { Plugin } from "rollup";

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

const urlRE = /(\?|&)url(?:&|$)/;
const unnededFinalQueryCharRE = /[?&]$/;

export async function fileToUrl(
  id: string,
  config: ResolvedConfig,
  ctx: PluginContext
): Promise<string> {
  return fileToDevUrl(id, config);
}

function fileToDevUrl(id: string, config: ResolvedConfig) {
  let rtn: string;
    rtn = "/" + path.posix.relative(config.root, id);
  const base = joinUrlSegments(config.server?.origin ?? "", config.base);
  return joinUrlSegments(base, removeLeadingSlash(rtn));
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
    },

    async load(id) {
      if (id[0] === "\0") {
        return;
      }

      if (!config.assetsInclude(cleanUrl(id)) && !urlRE.test(id)) {
        return;
      }

      id = id.replace(urlRE, "$1").replace(unnededFinalQueryCharRE, "");
      const url = await fileToUrl(id, config, this);
      return `export default ${JSON.stringify(url)}`;
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
