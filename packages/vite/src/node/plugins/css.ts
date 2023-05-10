import { ResolvedConfig } from "../config";
import { CSS_LANGS_RE, SPECIAL_QUERY_RE } from "../constants";
import { Plugin } from "../plugin";
import type * as PostCSS from "postcss";
import path from "node:path";
import type {
  ExistingRawSourceMap,
  RenderedChunk,
  RollupError,
  SourceMapInput,
} from "rollup";
import { checkPublicFile, publicFileToBuiltUrl, fileToUrl } from "./asset";
import {
  asyncReplace,
  cleanUrl,
  combineSourcemaps,
  generateCodeFrame,
  getHash,
  isDataUrl,
  isExternalUrl,
  isObject,
  joinUrlSegments,
  normalizePath,
  processSrcSet,
  removeDirectQuery,
  requireResolveFromRootWithFallback,
  stripBase,
} from "../utils";
import { ModuleNode } from "../server/moduleGraph";
import postcssrc from "postcss-load-config";
import type { ResolveFn, ViteDevServer } from "../";
import type Sass from "sass";
import type Stylus from "stylus";
import type Less from "less";
import colors from "picocolors";
import { Logger } from "../logger";
import glob from "fast-glob";
import type { RawSourceMap } from "@ampproject/remapping";
import type { Alias } from "dep-types/alias";
import MagicString from "magic-string";
import { createRequire } from "node:module";
import fsp from "node:fs/promises";

export interface StylePreprocessorResults {
  code: string;
  map?: ExistingRawSourceMap | undefined;
  additionalMap?: ExistingRawSourceMap | undefined;
  error?: RollupError;
  deps: string[];
}
// NOTE  Sass.Options  peerDependenciesMeta
type SassStylePreprocessorOptions = StylePreprocessorOptions & Sass.Options;

type StylusStylePreprocessorOptions = StylePreprocessorOptions & {
  define?: Record<string, any>;
};

type StylusStylePreprocessor = (
  source: string,
  root: string,
  options: StylusStylePreprocessorOptions,
  resolvers: CSSAtImportResolvers
) => StylePreprocessorResults | Promise<StylePreprocessorResults>;

type SassStylePreprocessor = (
  source: string,
  root: string,
  options: SassStylePreprocessorOptions,
  resolvers: CSSAtImportResolvers
) => StylePreprocessorResults | Promise<StylePreprocessorResults>;

type PreprocessorAdditionalDataResult =
  | string
  | { content: string; map?: ExistingRawSourceMap };

type PreprocessorAdditionalData =
  | string
  | ((
      source: string,
      filename: string
    ) =>
      | PreprocessorAdditionalDataResult
      | Promise<PreprocessorAdditionalDataResult>);

type StylePreprocessorOptions = {
  [key: string]: any;
  additionalData?: PreprocessorAdditionalData;
  filename: string;
  alias: Alias[];
  enableSourcemap: boolean;
};

type StylePreprocessor = (
  source: string,
  root: string,
  options: StylePreprocessorOptions,
  resolvers: CSSAtImportResolvers
) => StylePreprocessorResults | Promise<StylePreprocessorResults>;

const enum PreprocessLang {
  less = "less",
  sass = "sass",
  scss = "scss",
  styl = "styl",
  stylus = "stylus",
}
const enum PureCssLang {
  css = "css",
}
const enum PostCssDialectLang {
  sss = "sugarss",
}

const loadedPreprocessors: Partial<
  Record<PreprocessLang | PostCssDialectLang, any>
> = {};

type CssLang =
  | keyof typeof PureCssLang
  | keyof typeof PreprocessLang
  | keyof typeof PostCssDialectLang;

interface CSSAtImportResolvers {
  css: ResolveFn;
  sass: ResolveFn;
  less: ResolveFn;
}

const configToAtImportResolvers = new WeakMap<
  ResolvedConfig,
  CSSAtImportResolvers
>();

export const cssUrlRE =
  /(?<=^|[^\w\-\u0080-\uffff])url\((\s*('[^']+'|"[^"]+")\s*|[^'")]+)\)/;
export const cssDataUriRE =
  /(?<=^|[^\w\-\u0080-\uffff])data-uri\((\s*('[^']+'|"[^"]+")\s*|[^'")]+)\)/;
export const importCssRE = /@import ('[^']+\.css'|"[^"]+\.css"|[^'")]+\.css)/;

const cssImageSetRE =
  /(?<=image-set\()((?:[\w\-]{1,256}\([^)]*\)|[^)])*)(?=\))/;
const postcssReturnsVirtualFilesRE = /^<.+>$/;
const cssNotProcessedRE = /(?:gradient|element|cross-fade|image)\(/;

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

  const resolveUrl = config.createResolver({
    preferRelative: true,
    tryIndex: false,
    extensions: [],
  });

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
      const ssr = options?.ssr === true;

      const urlReplacer: CssUrlReplacer = async (url, importer) => {
        if (checkPublicFile(url, config)) {
          if (encodePublicUrlsInCSS(config)) {
            return publicFileToBuiltUrl(url, config);
          } else {
            return joinUrlSegments(config.base, url);
          }
        }
        const resolved = await resolveUrl(url, importer);
        if (resolved) {
          return fileToUrl(resolved, config, this);
        }
        if (config.command === "build") {
          config.logger.warnOnce(
            `\n${url} referenced in ${id} didn't resolve at build time, it will remain unchanged to be resolved at runtime`
          );
        }
        return url;
      };

      const {
        code: css,
        modules,
        deps,
        map,
      } = await compileCSS(id, raw, config, urlReplacer);
      if (modules) {
        moduleCache.set(id, modules);
      }

      if (config.command === "build" && config.build.watch && deps) {
        for (const file of deps) {
          this.addWatchFile(file);
        }
      }

      if (server) {
        const { moduleGraph } = server;
        const thisModule = moduleGraph.getModuleById(id);
        if (thisModule) {
          const isSelfAccepting =
            !modules && !inlineRE.test(id) && !htmlProxyRE.test(id);
          if (deps) {
            const depModules = new Set<string | ModuleNode>();
            const devBase = config.base;
            for (const file of deps) {
              depModules.add(
                isCSSRequest(file)
                  ? moduleGraph.createFileOnlyEntry(file)
                  : await moduleGraph.ensureEntryFromUrl(
                      stripBase(
                        await fileToUrl(file, config, this),
                        (config.server?.origin ?? "") + devBase
                      ),
                      ssr
                    )
              );
            }
            moduleGraph.updateModuleInfo(
              thisModule,
              depModules,
              null,
              new Set(),
              null,
              isSelfAccepting,
              ssr
            );
            for (const file of deps) {
              this.addWatchFile(file);
            }
          } else {
            thisModule.isSelfAccepting = isSelfAccepting;
          }
        }
      }

      return {
        code: css,
        map,
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

  // TODO ts类型
  const inlineOptions = config.css?.postcss as any;
  if (isObject(inlineOptions)) {
    const options = { ...inlineOptions };

    delete options.plugins;
    result = {
      options,
      plugins: inlineOptions.plugins || [],
    };
  } else {
    const searchPath =
      typeof inlineOptions === "string" ? inlineOptions : config.root;
    result = postcssrc({}, searchPath).catch((e) => {
      if (!/No PostCSS Config found/.test(e.message)) {
        if (e instanceof Error) {
          const { name, message, stack } = e;
          e.name = "Failed to load PostCSS config";
          e.message = `Failed to load PostCSS config (searchPath: ${searchPath}): [${name}] ${message}\n${stack}`;
          e.stack = ""; 
          throw e;
        } else {
          throw new Error(`Failed to load PostCSS config: ${e}`);
        }
      }
      return null;
    });
    result.then((resolved) => {
      postcssConfigCache.set(config, resolved);
    });
  }

  postcssConfigCache.set(config, result);
  return result;
}

function encodePublicUrlsInCSS(config: ResolvedConfig) {
  return config.command === "build";
}

async function compileCSS(
  id: string,
  code: string,
  config: ResolvedConfig,
  urlReplacer?: CssUrlReplacer
): Promise<{
  code: string;
  map?: SourceMapInput;
  ast?: PostCSS.Result;
  modules?: Record<string, string>;
  deps?: Set<string>;
}> {
  const {
    modules: modulesOptions,
    preprocessorOptions,
    devSourcemap,
  } = config.css || {};
  const isModule = modulesOptions !== false && cssModuleRE.test(id);
  const needInlineImport = code.includes("@import");
  const hasUrl = cssUrlRE.test(code) || cssImageSetRE.test(code);
  const lang = id.match(CSS_LANGS_RE)?.[1] as CssLang | undefined;
  const postcssConfig = await resolvePostcssConfig(config);

  if (
    lang === "css" &&
    !postcssConfig &&
    !isModule &&
    !needInlineImport &&
    !hasUrl
  ) {
    return { code, map: null };
  }

  let preprocessorMap: ExistingRawSourceMap | undefined;
  let modules: Record<string, string> | undefined;
  const deps = new Set<string>();

  let atImportResolvers = configToAtImportResolvers.get(config)!;
  if (!atImportResolvers) {
    atImportResolvers = createCSSResolvers(config);
    configToAtImportResolvers.set(config, atImportResolvers);
  }

  if (isPreProcessor(lang)) {
    const preProcessor = preProcessors[lang];
    let opts = (preprocessorOptions && preprocessorOptions[lang]) || {};
    switch (lang) {
      case PreprocessLang.scss:
      case PreprocessLang.sass:
        opts = {
          includePaths: ["node_modules"],
          alias: config.resolve.alias,
          ...opts,
        };
        break;
      case PreprocessLang.less:
      case PreprocessLang.styl:
      case PreprocessLang.stylus:
        opts = {
          paths: ["node_modules"],
          alias: config.resolve.alias,
          ...opts,
        };
    }
    opts.filename = cleanUrl(id);
    opts.enableSourcemap = devSourcemap ?? false;

    const preprocessResult = await preProcessor(
      code,
      config.root,
      opts,
      atImportResolvers
    );

    if (preprocessResult.error) {
      throw preprocessResult.error;
    }

    code = preprocessResult.code;
    preprocessorMap = combineSourcemapsIfExists(
      opts.filename,
      preprocessResult.map,
      preprocessResult.additionalMap
    );

    if (preprocessResult.deps) {
      // TODO ts
      preprocessResult.deps.forEach((dep) => {
        if (normalizePath(dep) !== normalizePath(opts.filename)) {
          deps.add(dep);
        }
      });
    }
  }

  const postcssOptions = (postcssConfig && postcssConfig.options) || {};

  const postcssPlugins =
    postcssConfig && postcssConfig.plugins ? postcssConfig.plugins.slice() : [];

  if (needInlineImport) {
    postcssPlugins.unshift(
      (await importPostcssImport()).default({
        async resolve(id, basedir) {
          const publicFile = checkPublicFile(id, config);
          if (publicFile) {
            return publicFile;
          }

          const resolved = await atImportResolvers.css(
            id,
            path.join(basedir, "*")
          );

          if (resolved) {
            return path.resolve(resolved);
          }

          if (!path.isAbsolute(id)) {
            config.logger.error(
              colors.red(
                `Unable to resolve \`@import "${id}"\` from ${basedir}`
              )
            );
          }

          return id;
        },
        nameLayer(index) {
          return `vite--anon-layer-${getHash(id)}-${index}`;
        },
      })
    );
  }

  if (urlReplacer) {
    postcssPlugins.push(
      UrlRewritePostcssPlugin({
        replacer: urlReplacer,
        logger: config.logger,
      })
    );
  }

  if (isModule) {
    postcssPlugins.unshift(
      (await importPostcssModules()).default({
        ...modulesOptions,
        localsConvention: modulesOptions?.localsConvention,
        getJSON(
          cssFileName: string,
          _modules: Record<string, string>,
          outputFileName: string
        ) {
          modules = _modules;
          if (modulesOptions && typeof modulesOptions.getJSON === "function") {
            modulesOptions.getJSON(cssFileName, _modules, outputFileName);
          }
        },
        async resolve(id: string, importer: string) {
          for (const key of getCssResolversKeys(atImportResolvers)) {
            const resolved = await atImportResolvers[key](id, importer);
            if (resolved) {
              return path.resolve(resolved);
            }
          }

          return id;
        },
      })
    );
  }

  if (!postcssPlugins.length) {
    return {
      code,
      map: preprocessorMap,
    };
  }

  let postcssResult: PostCSS.Result;
  try {
    const source = removeDirectQuery(id);
    const postcss = await importPostcss();
    postcssResult = await postcss.default(postcssPlugins).process(code, {
      ...postcssOptions,
      parser:
        lang === "sss"
          ? loadPreprocessor(PostCssDialectLang.sss, config.root)
          : postcssOptions.parser,
      to: source,
      from: source,
      ...(devSourcemap
        ? {
            map: {
              inline: false,
              annotation: false,
              sourcesContent: true,
            },
          }
        : {}),
    });

    for (const message of postcssResult.messages) {
      if (message.type === "dependency") {
        deps.add(normalizePath(message.file as string));
      } else if (message.type === "dir-dependency") {
        const { dir, glob: globPattern = "**" } = message;
        const pattern =
          glob.escapePath(normalizePath(path.resolve(path.dirname(id), dir))) +
          `/` +
          globPattern;
        const files = glob.sync(pattern, {
          ignore: ["**/node_modules/**"],
        });
        for (let i = 0; i < files.length; i++) {
          deps.add(files[i]);
        }
      } else if (message.type === "warning") {
        let msg = `[vite:css] ${message.text}`;
        if (message.line && message.column) {
          msg += `\n${generateCodeFrame(code, {
            line: message.line,
            column: message.column,
          })}`;
        }
        config.logger.warn(colors.yellow(msg));
      }
    }
  } catch (e) {
    e.message = `[postcss] ${e.message}`;
    e.code = code;
    e.loc = {
      column: e.column,
      line: e.line,
    };
    throw e;
  }

  if (!devSourcemap) {
    return {
      ast: postcssResult,
      code: postcssResult.css,
      map: { mappings: "" },
      modules,
      deps,
    };
  }

  const rawPostcssMap = postcssResult.map.toJSON();

  const postcssMap = await formatPostcssSourceMap(
    rawPostcssMap as Omit<RawSourceMap, "version"> as ExistingRawSourceMap,
    cleanUrl(id)
  );

  return {
    ast: postcssResult,
    code: postcssResult.css,
    map: combineSourcemapsIfExists(cleanUrl(id), postcssMap, preprocessorMap),
    modules,
    deps,
  };
}

function createCSSResolvers(config: ResolvedConfig): CSSAtImportResolvers {
  let cssResolve: ResolveFn | undefined;
  let sassResolve: ResolveFn | undefined;
  let lessResolve: ResolveFn | undefined;
  return {
    get css() {
      return (
        cssResolve ||
        (cssResolve = config.createResolver({
          extensions: [".css"],
          mainFields: ["style"],
          conditions: ["style"],
          tryIndex: false,
          preferRelative: true,
        }))
      );
    },

    get sass() {
      return (
        sassResolve ||
        (sassResolve = config.createResolver({
          extensions: [".scss", ".sass", ".css"],
          mainFields: ["sass", "style"],
          conditions: ["sass", "style"],
          tryIndex: true,
          tryPrefix: "_",
          preferRelative: true,
        }))
      );
    },

    get less() {
      return (
        lessResolve ||
        (lessResolve = config.createResolver({
          extensions: [".less", ".css"],
          mainFields: ["less", "style"],
          conditions: ["less", "style"],
          tryIndex: false,
          preferRelative: true,
        }))
      );
    },
  };
}

const less: StylePreprocessor = async (source, root, options, resolvers) => {
  const nodeLess = loadPreprocessor(PreprocessLang.less, root);
  const viteResolverPlugin = createViteLessPlugin(
    nodeLess,
    options.filename,
    options.alias,
    resolvers
  );
  const { content, map: additionalMap } = await getSource(
    source,
    options.filename,
    options.additionalData,
    options.enableSourcemap
  );

  let result: Less.RenderOutput | undefined;
  try {
    result = await nodeLess.render(content, {
      ...options,
      plugins: [viteResolverPlugin, ...(options.plugins || [])],
      ...(options.enableSourcemap
        ? {
            sourceMap: {
              outputSourceFiles: true,
              sourceMapFileInline: false,
            },
          }
        : {}),
    });
  } catch (e) {
    const error = e as Less.RenderError;
    const normalizedError: RollupError = new Error(
      `[less] ${error.message || error.type}`
    ) as RollupError;
    normalizedError.loc = {
      file: error.filename || options.filename,
      line: error.line,
      column: error.column,
    };
    return { code: "", error: normalizedError, deps: [] };
  }

  const map: ExistingRawSourceMap = result.map && JSON.parse(result.map);
  if (map) {
    delete map.sourcesContent;
  }

  return {
    code: result.css.toString(),
    map,
    additionalMap,
    deps: result.imports,
  };
};

const sass: SassStylePreprocessor = (source, root, options, aliasResolver) =>
  scss(
    source,
    root,
    {
      ...options,
      indentedSyntax: true,
    },
    aliasResolver
  );

const scss: SassStylePreprocessor = async (
  source,
  root,
  options,
  resolvers
) => {
  const render = loadPreprocessor(PreprocessLang.sass, root).render;

  const internalImporter: Sass.Importer = (url, importer, done) => {
    importer = cleanScssBugUrl(importer);
    resolvers.sass(url, importer).then((resolved) => {
      if (resolved) {
        rebaseUrls(resolved, options.filename, options.alias, "$")
          .then((data) => done?.(fixScssBugImportValue(data)))
          .catch((data) => done?.(data));
      } else {
        done?.(null);
      }
    });
  };
  const importer = [internalImporter];
  if (options.importer) {
    Array.isArray(options.importer)
      ? importer.unshift(...options.importer)
      : importer.unshift(options.importer);
  }

  const { content: data, map: additionalMap } = await getSource(
    source,
    options.filename,
    options.additionalData,
    options.enableSourcemap
  );
  const finalOptions: Sass.Options = {
    ...options,
    data,
    file: options.filename,
    outFile: options.filename,
    importer,
    ...(options.enableSourcemap
      ? {
          sourceMap: true,
          omitSourceMapUrl: true,
          sourceMapRoot: path.dirname(options.filename),
        }
      : {}),
  };

  try {
    const result = await new Promise<Sass.Result>((resolve, reject) => {
      render(finalOptions, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
    const deps = result.stats.includedFiles.map((f) => cleanScssBugUrl(f));
    const map: ExistingRawSourceMap | undefined = result.map
      ? JSON.parse(result.map.toString())
      : undefined;

    return {
      code: result.css.toString(),
      map,
      additionalMap,
      deps,
    };
  } catch (e) {
    e.message = `[sass] ${e.message}`;
    e.id = e.file;
    e.frame = e.formatted;
    return { code: "", error: e, deps: [] };
  }
};

const styl: StylusStylePreprocessor = async (source, root, options) => {
  const nodeStylus = loadPreprocessor(PreprocessLang.stylus, root);
  const { content, map: additionalMap } = await getSource(
    source,
    options.filename,
    options.additionalData,
    options.enableSourcemap,
    "\n"
  );
  const importsDeps = (options.imports ?? []).map((dep: string) =>
    path.resolve(dep)
  );
  try {
    const ref = nodeStylus(content, options);
    if (options.define) {
      for (const key in options.define) {
        ref.define(key, options.define[key]);
      }
    }
    if (options.enableSourcemap) {
      ref.set("sourcemap", {
        comment: false,
        inline: false,
        basePath: root,
      });
    }

    const result = ref.render();

    const deps = [...ref.deps(), ...importsDeps];
    // @ts-expect-error sourcemap exists
    const map: ExistingRawSourceMap | undefined = ref.sourcemap;

    return {
      code: result,
      map: formatStylusSourceMap(map, root),
      additionalMap,
      deps,
    };
  } catch (e) {
    e.message = `[stylus] ${e.message}`;
    return { code: "", error: e, deps: [] };
  }
};

const preProcessors = Object.freeze({
  [PreprocessLang.less]: less,
  [PreprocessLang.sass]: sass,
  [PreprocessLang.scss]: scss,
  [PreprocessLang.styl]: styl,
  [PreprocessLang.stylus]: styl,
});

function isPreProcessor(lang: any): lang is PreprocessLang {
  return lang && lang in preProcessors;
}

function combineSourcemapsIfExists(
  filename: string,
  map1: ExistingRawSourceMap | undefined,
  map2: ExistingRawSourceMap | undefined
): ExistingRawSourceMap | undefined {
  return map1 && map2
    ? (combineSourcemaps(filename, [
        map1 as RawSourceMap,
        map2 as RawSourceMap,
      ]) as ExistingRawSourceMap)
    : map1;
}

function createCachedImport<T>(imp: () => Promise<T>): () => T | Promise<T> {
  let cached: T | Promise<T>;
  return () => {
    if (!cached) {
      cached = imp().then((module) => {
        cached = module;
        return module;
      });
    }
    return cached;
  };
}

const importPostcssImport = createCachedImport(() => import("postcss-import"));
const importPostcssModules = createCachedImport(
  () => import("postcss-modules")
);
const importPostcss = createCachedImport(() => import("postcss"));

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
const _require = createRequire(import.meta.url);

function getCssResolversKeys(
  resolvers: CSSAtImportResolvers
): Array<keyof CSSAtImportResolvers> {
  return Object.keys(resolvers) as unknown as Array<keyof CSSAtImportResolvers>;
}

function loadPreprocessor(lang: PreprocessLang.scss, root: string): typeof Sass;
function loadPreprocessor(lang: PreprocessLang.sass, root: string): typeof Sass;
function loadPreprocessor(lang: PreprocessLang.less, root: string): typeof Less;
function loadPreprocessor(
  lang: PreprocessLang.stylus,
  root: string
): typeof Stylus;
function loadPreprocessor(
  lang: PostCssDialectLang.sss,
  root: string
): PostCSS.Parser;
function loadPreprocessor(
  lang: PreprocessLang | PostCssDialectLang,
  root: string
): any {
  if (lang in loadedPreprocessors) {
    return loadedPreprocessors[lang];
  }
  try {
    const resolved = requireResolveFromRootWithFallback(root, lang);
    return (loadedPreprocessors[lang] = _require(resolved));
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
      throw new Error(
        `Preprocessor dependency "${lang}" not found. Did you install it?`
      );
    } else {
      const message = new Error(
        `Preprocessor dependency "${lang}" failed to load:\n${e.message}`
      );
      message.stack = e.stack + "\n" + message.stack;
      throw message;
    }
  }
}

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

let ViteLessManager: any;
function createViteLessPlugin(
  less: typeof Less,
  rootFile: string,
  alias: Alias[],
  resolvers: CSSAtImportResolvers
): Less.Plugin {
  if (!ViteLessManager) {
    ViteLessManager = class ViteManager extends less.FileManager {
      resolvers;
      rootFile;
      alias;
      constructor(
        rootFile: string,
        resolvers: CSSAtImportResolvers,
        alias: Alias[]
      ) {
        super();
        this.rootFile = rootFile;
        this.resolvers = resolvers;
        this.alias = alias;
      }
      override supports(filename: string) {
        return !isExternalUrl(filename);
      }
      override supportsSync() {
        return false;
      }
      override async loadFile(
        filename: string,
        dir: string,
        opts: any,
        env: any
      ): Promise<Less.FileLoadResult> {
        const resolved = await this.resolvers.less(
          filename,
          path.join(dir, "*")
        );
        if (resolved) {
          const result = await rebaseUrls(
            resolved,
            this.rootFile,
            this.alias,
            "@"
          );
          let contents: string;
          if (result && "contents" in result) {
            contents = result.contents;
          } else {
            contents = await fsp.readFile(resolved, "utf-8");
          }
          return {
            filename: path.resolve(resolved),
            contents,
          };
        } else {
          return super.loadFile(filename, dir, opts, env);
        }
      }
    };
  }

  return {
    install(_, pluginManager) {
      pluginManager.addFileManager(
        new ViteLessManager(rootFile, resolvers, alias)
      );
    },
    minVersion: [3, 0, 0],
  };
}

async function getSource(
  source: string,
  filename: string,
  additionalData: PreprocessorAdditionalData | undefined,
  enableSourcemap: boolean,
  sep: string = ""
): Promise<{ content: string; map?: ExistingRawSourceMap }> {
  if (!additionalData) return { content: source };

  if (typeof additionalData === "function") {
    const newContent = await additionalData(source, filename);
    if (typeof newContent === "string") {
      return { content: newContent };
    }
    return newContent;
  }

  if (!enableSourcemap) {
    return { content: additionalData + sep + source };
  }

  const ms = new MagicString(source);
  ms.appendLeft(0, sep);
  ms.appendLeft(0, additionalData);

  const map = ms.generateMap({ hires: true });
  map.file = filename;
  map.sources = [filename];

  return {
    content: ms.toString(),
    map,
  };
}

function cleanScssBugUrl(url: string) {
  if (
    typeof window !== "undefined" &&
    typeof location !== "undefined" &&
    typeof location?.href === "string"
  ) {
    const prefix = location.href.replace(/\/$/, "");
    return url.replace(prefix, "");
  } else {
    return url;
  }
}

async function rebaseUrls(
  file: string,
  rootFile: string,
  alias: Alias[],
  variablePrefix: string
): Promise<Sass.ImporterReturnType> {
  file = path.resolve(file); 
  const fileDir = path.dirname(file);
  const rootDir = path.dirname(rootFile);
  if (fileDir === rootDir) {
    return { file };
  }

  const content = await fsp.readFile(file, "utf-8");
  const hasUrls = cssUrlRE.test(content);
  const hasDataUris = cssDataUriRE.test(content);
  const hasImportCss = importCssRE.test(content);

  if (!hasUrls && !hasDataUris && !hasImportCss) {
    return { file };
  }

  let rebased;
  const rebaseFn = (url: string) => {
    if (url[0] === "/") return url;
    if (url.startsWith(variablePrefix)) return url;
    for (const { find } of alias) {
      const matches =
        typeof find === "string" ? url.startsWith(find) : find.test(url);
      if (matches) {
        return url;
      }
    }
    const absolute = path.resolve(fileDir, url);
    const relative = path.relative(rootDir, absolute);
    return normalizePath(relative);
  };
  if (hasImportCss) {
    rebased = await rewriteImportCss(content, rebaseFn);
  }
  if (hasUrls) {
    rebased = await rewriteCssUrls(rebased || content, rebaseFn);
  }
  if (hasDataUris) {
    rebased = await rewriteCssDataUris(rebased || content, rebaseFn);
  }
  return {
    file,
    contents: rebased,
  };
}

function fixScssBugImportValue(
  data: Sass.ImporterReturnType
): Sass.ImporterReturnType {
  if (
    typeof window !== "undefined" &&
    typeof location !== "undefined" &&
    data &&
    "file" in data &&
    // @ts-ignore
    (!("contents" in data) || data.contents == null)
  ) {
    // @ts-expect-error we need to preserve file property for HMR
    data.contents = fs.readFileSync(data.file, "utf-8");
  }
  return data;
}

function formatStylusSourceMap(
  mapBefore: ExistingRawSourceMap | undefined,
  root: string
): ExistingRawSourceMap | undefined {
  if (!mapBefore) return undefined;
  const map = { ...mapBefore };

  const resolveFromRoot = (p: string) => normalizePath(path.resolve(root, p));

  if (map.file) {
    map.file = resolveFromRoot(map.file);
  }
  map.sources = map.sources.map(resolveFromRoot);

  return map;
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

function rewriteImportCss(
  css: string,
  replacer: CssUrlReplacer
): Promise<string> {
  return asyncReplace(css, importCssRE, async (match) => {
    const [matched, rawUrl] = match;
    return await doImportCSSReplace(rawUrl, matched, replacer);
  });
}

function rewriteCssDataUris(
  css: string,
  replacer: CssUrlReplacer
): Promise<string> {
  return asyncReplace(css, cssDataUriRE, async (match) => {
    const [matched, rawUrl] = match;
    return await doUrlReplace(rawUrl.trim(), matched, replacer, "data-uri");
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

async function doImportCSSReplace(
  rawUrl: string,
  matched: string,
  replacer: CssUrlReplacer
) {
  let wrap = "";
  const first = rawUrl[0];
  if (first === `"` || first === `'`) {
    wrap = first;
    rawUrl = rawUrl.slice(1, -1);
  }
  if (isExternalUrl(rawUrl) || isDataUrl(rawUrl) || rawUrl[0] === "#") {
    return matched;
  }

  return `@import ${wrap}${await replacer(rawUrl)}${wrap}`;
}
