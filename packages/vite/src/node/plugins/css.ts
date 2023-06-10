import { ResolvedConfig } from "../config";
import {
  CLIENT_PUBLIC_PATH,
  CSS_LANGS_RE,
  SPECIAL_QUERY_RE,
} from "../constants";
import { Plugin } from "../plugin";
import path from "node:path";
import type { RenderedChunk } from "rollup";
import { stripBomTag } from "../utils";
import type { ViteDevServer } from "../";
import { dataToEsm } from "@rollup/pluginutils";

const cssModulesCache = new WeakMap<
  ResolvedConfig,
  Map<string, Record<string, string>>
>();

export const removedPureCssFilesCache = new WeakMap<
  ResolvedConfig,
  Map<string, RenderedChunk>
>();

const cssModuleRE = new RegExp(`\\.module${CSS_LANGS_RE.source}`);
const directRequestRE = /(?:\?|&)direct\b/;
const htmlProxyRE = /(?:\?|&)html-proxy\b/;
const commonjsProxyRE = /\?commonjs-proxy/;
const inlineRE = /(?:\?|&)inline\b/;

export const isCSSRequest = (request: string): boolean =>
  CSS_LANGS_RE.test(request);

export const isDirectCSSRequest = (request: string): boolean =>
  CSS_LANGS_RE.test(request) && directRequestRE.test(request);

export function cssPlugin(config: ResolvedConfig): Plugin {
  let server: ViteDevServer;
  let moduleCache: Map<string, Record<string, string>>;

  return {
    name: "vite:css",

    configureServer(_server) {
      server = _server;
    },

    buildStart() {
      moduleCache = new Map<string, Record<string, string>>();
      cssModulesCache.set(config, moduleCache);

      removedPureCssFilesCache.set(config, new Map<string, RenderedChunk>());
    },

    async transform(raw, id, options) {
      if (
        !isCSSRequest(id) ||
        commonjsProxyRE.test(id) ||
        SPECIAL_QUERY_RE.test(id)
      ) {
        return;
      }

      if (server) {
        const { moduleGraph } = server;
        const thisModule = moduleGraph.getModuleById(id);
        if (thisModule) {
          const isSelfAccepting = !inlineRE.test(id) && !htmlProxyRE.test(id);
          thisModule.isSelfAccepting = isSelfAccepting;
        }
      }

      return {
        code: raw,
        map: null,
      };
    },
  };
}

export const isDirectRequest = (request: string): boolean =>
  directRequestRE.test(request);

export const isModuleCSSRequest = (request: string): boolean =>
  cssModuleRE.test(request);

export function cssPostPlugin(config: ResolvedConfig): Plugin {
  return {
    name: "vite:css-post",

    buildStart() {},

    async transform(css, id) {
      if (
        !isCSSRequest(id) ||
        commonjsProxyRE.test(id) ||
        SPECIAL_QUERY_RE.test(id)
      ) {
        return;
      }

      css = stripBomTag(css);

      const inlined = inlineRE.test(id);
      const modules = cssModulesCache.get(config)!.get(id);

      const modulesCode =
        modules &&
        !inlined &&
        dataToEsm(modules, { namedExports: true, preferConst: true });

      if (config.command === "serve") {
        const getContentWithSourcemap = async (content: string) => {
          return content;
        };

        if (isDirectCSSRequest(id)) {
          return null;
        }
        if (inlined) {
          return `export default ${JSON.stringify(css)}`;
        }

        const cssContent = await getContentWithSourcemap(css);
        const code = [
          `import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from ${JSON.stringify(
            path.posix.join(config.base, CLIENT_PUBLIC_PATH)
          )}`,
          `const __vite__id = ${JSON.stringify(id)}`,
          `const __vite__css = ${JSON.stringify(cssContent)}`,
          `__vite__updateStyle(__vite__id, __vite__css)`,
          `${
            modulesCode ||
            `import.meta.hot.accept()\nexport default __vite__css`
          }`,
          `import.meta.hot.prune(() => __vite__removeStyle(__vite__id))`,
        ].join("\n");
        return { code, map: { mappings: "" } };
      }
    },
  };
}
