import path from "node:path";
import { ResolvedConfig } from "../config";
import {
  cleanUrl,
  joinUrlSegments,
  removeLeadingSlash,
} from "../utils";
import type { Plugin } from "rollup";

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
      const url = await fileToUrl(id, config);
      return `export default ${JSON.stringify(url)}`;
    },

  };
}
