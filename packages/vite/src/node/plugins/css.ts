import { ResolvedConfig } from "../config";
import {
  CLIENT_PUBLIC_PATH,
  CSS_LANGS_RE,
  SPECIAL_QUERY_RE,
} from "../constants";
import { Plugin } from "../plugin";
import type * as PostCSS from "postcss";
import path from "node:path";
import type { ExistingRawSourceMap, RenderedChunk, RollupError } from "rollup";
import {
  asyncReplace,
  cleanUrl,
  emptyCssComments,
  getHash,
  isDataUrl,
  isExternalUrl,
  normalizePath,
  parseRequest,
  processSrcSet,
  stripBomTag,
} from "../utils";
import postcssrc from "postcss-load-config";
import type { ViteDevServer } from "../";
import colors from "picocolors";
import { Logger } from "../logger";
import MagicString from "magic-string";
import { dataToEsm } from "@rollup/pluginutils";
import { addToHTMLProxyTransformResult } from "./html";
import { formatMessages, transform, TransformOptions } from "esbuild";
import { ESBuildOptions } from "./esbuild";

export interface StylePreprocessorResults {
  code: string;
  map?: ExistingRawSourceMap | undefined;
  additionalMap?: ExistingRawSourceMap | undefined;
  error?: RollupError;
  deps: string[];
}

export const cssUrlRE =
  /(?<=^|[^\w\-\u0080-\uffff])url\((\s*('[^']+'|"[^"]+")\s*|[^'")]+)\)/;
export const cssDataUriRE =
  /(?<=^|[^\w\-\u0080-\uffff])data-uri\((\s*('[^']+'|"[^"]+")\s*|[^'")]+)\)/;
export const importCssRE = /@import ('[^']+\.css'|"[^"]+\.css"|[^'")]+\.css)/;

const cssImageSetRE =
  /(?<=image-set\()((?:[\w\-]{1,256}\([^)]*\)|[^)])*)(?=\))/;
const postcssReturnsVirtualFilesRE = /^<.+>$/;
const cssNotProcessedRE = /(?:gradient|element|cross-fade|image)\(/;
const inlineCSSRE = /(?:\?|&)inline-css\b/;
const usedRE = /(?:\?|&)used\b/;

interface PostCSSConfigResult {
  options: PostCSS.ProcessOptions;
  plugins: PostCSS.AcceptedPlugin[];
}

const cssModulesCache = new WeakMap<
  ResolvedConfig,
  Map<string, Record<string, string>>
>();

const postcssConfigCache = new WeakMap<
  ResolvedConfig,
  PostCSSConfigResult | null | Promise<PostCSSConfigResult | null>
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
const varRE = /^var\(/i;

type CssUrlReplacer = (
  url: string,
  importer?: string
) => string | Promise<string>;

export const isCSSRequest = (request: string): boolean =>
  CSS_LANGS_RE.test(request);

export const isDirectCSSRequest = (request: string): boolean =>
  CSS_LANGS_RE.test(request) && directRequestRE.test(request);

export function cssPlugin(config: ResolvedConfig): Plugin {
  let server: ViteDevServer;
  let moduleCache: Map<string, Record<string, string>>;

  resolvePostcssConfig(config);

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

async function resolvePostcssConfig(
  config: ResolvedConfig
): Promise<PostCSSConfigResult | null> {
  let result = postcssConfigCache.get(config);
  if (result !== undefined) {
    return await result;
  }

  const inlineOptions = config.css?.postcss as any;
  const searchPath =
    typeof inlineOptions === "string" ? inlineOptions : config.root;
  result = postcssrc({}, searchPath).catch((e) => {
    return null;
  });
  result.then((resolved) => {
    postcssConfigCache.set(config, resolved);
  });

  postcssConfigCache.set(config, result);
  return result;
}

const UrlRewritePostcssPlugin: PostCSS.PluginCreator<{
  replacer: CssUrlReplacer;
  logger: Logger;
}> = (opts) => {
  if (!opts) {
    throw new Error("base or replace is required");
  }

  return {
    postcssPlugin: "vite-url-rewrite",
    Once(root) {
      const promises: Promise<void>[] = [];
      root.walkDecls((declaration) => {
        const importer = declaration.source?.input.file;
        if (!importer) {
          opts.logger.warnOnce(
            "\nA PostCSS plugin did not pass the `from` option to `postcss.parse`. " +
              "This may cause imported assets to be incorrectly transformed. " +
              "If you've recently added a PostCSS plugin that raised this warning, " +
              "please contact the package author to fix the issue."
          );
        }
        const isCssUrl = cssUrlRE.test(declaration.value);
        const isCssImageSet = cssImageSetRE.test(declaration.value);
        if (isCssUrl || isCssImageSet) {
          const replacerForDeclaration = (rawUrl: string) => {
            return opts.replacer(rawUrl, importer);
          };
          const rewriterToUse = isCssImageSet
            ? rewriteCssImageSet
            : rewriteCssUrls;
          promises.push(
            rewriterToUse(declaration.value, replacerForDeclaration).then(
              (url) => {
                declaration.value = url;
              }
            )
          );
        }
      });
      if (promises.length) {
        return Promise.all(promises) as any;
      }
    },
  };
};

UrlRewritePostcssPlugin.postcss = true;

export async function formatPostcssSourceMap(
  rawMap: ExistingRawSourceMap,
  file: string
): Promise<ExistingRawSourceMap> {
  const inputFileDir = path.dirname(file);

  const sources = rawMap.sources.map((source) => {
    const cleanSource = cleanUrl(decodeURIComponent(source));

    if (postcssReturnsVirtualFilesRE.test(cleanSource)) {
      return `\0${cleanSource}`;
    }

    return normalizePath(path.resolve(inputFileDir, cleanSource));
  });

  return {
    file,
    mappings: rawMap.mappings,
    names: rawMap.names,
    sources,
    sourcesContent: rawMap.sourcesContent,
    version: rawMap.version,
  };
}

async function rewriteCssImageSet(
  css: string,
  replacer: CssUrlReplacer
): Promise<string> {
  return await asyncReplace(css, cssImageSetRE, async (match) => {
    const [, rawUrl] = match;
    const url = await processSrcSet(rawUrl, async ({ url }) => {
      if (cssUrlRE.test(url)) {
        return await rewriteCssUrls(url, replacer);
      }
      if (!cssNotProcessedRE.test(url)) {
        return await doUrlReplace(url, url, replacer);
      }
      return url;
    });
    return url;
  });
}

function rewriteCssUrls(
  css: string,
  replacer: CssUrlReplacer
): Promise<string> {
  return asyncReplace(css, cssUrlRE, async (match) => {
    const [matched, rawUrl] = match;
    return await doUrlReplace(rawUrl.trim(), matched, replacer);
  });
}

async function doUrlReplace(
  rawUrl: string,
  matched: string,
  replacer: CssUrlReplacer,
  funcName: string = "url"
) {
  let wrap = "";
  const first = rawUrl[0];
  if (first === `"` || first === `'`) {
    wrap = first;
    rawUrl = rawUrl.slice(1, -1);
  }

  if (
    isExternalUrl(rawUrl) ||
    isDataUrl(rawUrl) ||
    rawUrl[0] === "#" ||
    varRE.test(rawUrl)
  ) {
    return matched;
  }

  const newUrl = await replacer(rawUrl);
  if (wrap === "" && newUrl !== encodeURI(newUrl)) {
    wrap = "'";
  }
  return `${funcName}(${wrap}${newUrl}${wrap})`;
}

export const isDirectRequest = (request: string): boolean =>
  directRequestRE.test(request);

export const isModuleCSSRequest = (request: string): boolean =>
  cssModuleRE.test(request);

export function cssPostPlugin(config: ResolvedConfig): Plugin {
  const styles: Map<string, string> = new Map<string, string>();
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

      const inlineCSS = inlineCSSRE.test(id);
      const isHTMLProxy = htmlProxyRE.test(id);
      const query = parseRequest(id);
      if (inlineCSS && isHTMLProxy) {
        addToHTMLProxyTransformResult(
          `${getHash(cleanUrl(id))}_${Number.parseInt(query!.index)}`,
          css
        );
        return `export default ''`;
      }
      if (!inlined) {
        styles.set(id, css);
      }

      let code: string;
      if (usedRE.test(id)) {
        if (modulesCode) {
          code = modulesCode;
        } else {
          let content = css;
          if (config.build.cssMinify) {
            content = await minifyCSS(content, config);
          }
          code = `export default ${JSON.stringify(content)}`;
        }
      } else {
        code = modulesCode || `export default ''`;
      }

      return {
        code,
        map: { mappings: "" },
        moduleSideEffects: inlined ? false : "no-treeshake",
      };
    },

    augmentChunkHash(chunk) {
      if (chunk.viteMetadata?.importedCss.size) {
        let hash = "";
        for (const id of chunk.viteMetadata.importedCss) {
          hash += id;
        }
        return hash;
      }
    },
  };
}

async function minifyCSS(css: string, config: ResolvedConfig) {
  try {
    const { code, warnings } = await transform(css, {
      loader: "css",
      target: config.build.cssTarget || undefined,
      ...resolveMinifyCssEsbuildOptions(config.esbuild || {}),
    });
    if (warnings.length) {
      const msgs = await formatMessages(warnings, { kind: "warning" });
      config.logger.warn(
        colors.yellow(`warnings when minifying css:\n${msgs.join("\n")}`)
      );
    }
    return code;
  } catch (e) {
    if (e.errors) {
      e.message = "[esbuild css minify] " + e.message;
      const msgs = await formatMessages(e.errors, { kind: "error" });
      e.frame = "\n" + msgs.join("\n");
      e.loc = e.errors[0].location;
    }
    throw e;
  }
}

function resolveMinifyCssEsbuildOptions(
  options: ESBuildOptions
): TransformOptions {
  const base: TransformOptions = {
    charset: options.charset ?? "utf8",
    logLevel: options.logLevel,
    logLimit: options.logLimit,
    logOverride: options.logOverride,
  };

  if (
    options.minifyIdentifiers != null ||
    options.minifySyntax != null ||
    options.minifyWhitespace != null
  ) {
    return {
      ...base,
      minifyIdentifiers: options.minifyIdentifiers ?? true,
      minifySyntax: options.minifySyntax ?? true,
      minifyWhitespace: options.minifyWhitespace ?? true,
    };
  } else {
    return { ...base, minify: true };
  }
}

export async function hoistAtRules(css: string): Promise<string> {
  const s = new MagicString(css);
  const cleanCss = emptyCssComments(css);
  let match: RegExpExecArray | null;

  const atImportRE =
    /@import(?:\s*(?:url\([^)]*\)|"(?:[^"]|(?<=\\)")*"|'(?:[^']|(?<=\\)')*').*?|[^;]*);/g;
  while ((match = atImportRE.exec(cleanCss))) {
    s.remove(match.index, match.index + match[0].length);
    s.appendLeft(0, match[0]);
  }

  const atCharsetRE =
    /@charset(?:\s*(?:"(?:[^"]|(?<=\\)")*"|'(?:[^']|(?<=\\)')*').*?|[^;]*);/g;
  let foundCharset = false;
  while ((match = atCharsetRE.exec(cleanCss))) {
    s.remove(match.index, match.index + match[0].length);
    if (!foundCharset) {
      s.prepend(match[0]);
      foundCharset = true;
    }
  }

  return s.toString();
}
