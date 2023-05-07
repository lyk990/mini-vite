import type { BuildContext, Loader, OnLoadResult, Plugin } from "esbuild";
import esbuild, { formatMessages, transform } from "esbuild";
import { ResolvedConfig } from "../config";
import {
  CSS_LANGS_RE,
  EXTERNAL_TYPES,
  JS_TYPES_RE,
  KNOWN_ASSET_TYPES,
  SPECIAL_QUERY_RE,
} from "../constants";
import glob from "fast-glob";
import { createPluginContainer, PluginContainer } from "../pluginContainer";
import {
  cleanUrl,
  dataUrlRE,
  externalRE,
  isInNodeModules,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE,
} from "../utils";
import path from "node:path";
import fsp from "node:fs/promises";

const htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/;
export const commentRE = /<!--.*?-->/gs;
export const scriptRE =
  /(<script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?)*\s*>)(.*?)<\/script>/gis;
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm;
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;

type ResolveIdOptions = Parameters<PluginContainer["resolveId"]>[2];

export function scanImports(config: ResolvedConfig): {
  cancel: () => Promise<void>;
  result: Promise<{
    deps: Record<string, string>;
    missing: Record<string, string>;
  }>;
} {
  //依赖扫描入口文件
  const deps: Record<string, string> = {};
  const missing: Record<string, string> = {};
  let entries: string[];
  const scanContext = { cancelled: false }; // REMOVE 移除scanContext

  const esbuildContext: Promise<BuildContext | undefined> = computeEntries(
    config
  ).then((computedEntries) => {
    entries = computedEntries;
    return prepareEsbuildScanner(config, entries, deps, missing, scanContext);
  });

  const result = esbuildContext.then((context) => {
    //  如果没有扫描到入口文件，直接返回
    if (!context || scanContext?.cancelled) {
      return { deps: {}, missing: {} };
    }
    return context.rebuild().then(() => {
      return {
        deps: orderedDependencies(deps),
        missing,
      };
    });
  });
  return {
    cancel: async () => {
      scanContext.cancelled = true;
      return esbuildContext.then((context) => context?.cancel());
    },
    result,
  };
}

function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[]
): Plugin {
  const seen = new Map<string, string | undefined>();

  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions
  ) => {
    const key = id + (importer && path.dirname(importer));
    if (seen.has(key)) {
      return seen.get(key);
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      }
    );
    const res = resolved?.id;
    seen.set(key, res);
    return res;
  };

  const include = config.optimizeDeps?.include;
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    "@vite/client",
    "@vite/env",
  ];

  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: !entries.includes(path),
  });

  const doTransformGlobImport = async (
    contents: string,
    id: string,
    loader: Loader
  ) => {
    let transpiledContents;
    if (loader !== "js") {
      transpiledContents = (await transform(contents, { loader })).code;
    } else {
      transpiledContents = contents;
    }
  
    return transpiledContents;
  };

  return {
    name: "vite:dep-scan",
    setup(build) {
      const scripts: Record<string, OnLoadResult> = {};

      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true,
      }));

      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true,
      }));

      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          path: path.replace(virtualModulePrefix, ""),
          namespace: "script",
        };
      });

      build.onLoad({ filter: /.*/, namespace: "script" }, ({ path }) => {
        return scripts[path];
      });

      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        const resolved = await resolve(path, importer);
        if (!resolved) return;
        if (
          isInNodeModules(resolved) &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return;
        return {
          path: resolved,
          namespace: "html",
        };
      });

      build.onLoad(
        { filter: htmlTypesRE, namespace: "html" },
        async ({ path }) => {
          let raw = await fsp.readFile(path, "utf-8");
          raw = raw.replace(commentRE, "<!---->");
          const isHtml = path.endsWith(".html");
          scriptRE.lastIndex = 0;
          let js = "";
          let scriptId = 0;
          let match: RegExpExecArray | null;
          while ((match = scriptRE.exec(raw))) {
            const [, openTag, content] = match;
            const typeMatch = openTag.match(typeRE);
            const type =
              typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3]);
            const langMatch = openTag.match(langRE);
            const lang =
              langMatch && (langMatch[1] || langMatch[2] || langMatch[3]);
            if (isHtml && type !== "module") {
              continue;
            }
            if (
              type &&
              !(
                type.includes("javascript") ||
                type.includes("ecmascript") ||
                type === "module"
              )
            ) {
              continue;
            }
            let loader: Loader = "js";
            if (lang === "ts" || lang === "tsx" || lang === "jsx") {
              loader = lang;
            } else if (path.endsWith(".astro")) {
              loader = "ts";
            }
            const srcMatch = openTag.match(srcRE);
            if (srcMatch) {
              const src = srcMatch[1] || srcMatch[2] || srcMatch[3];
              js += `import ${JSON.stringify(src)}\n`;
            } else if (content.trim()) {
              const contents =
                content +
                (loader.startsWith("ts") ? extractImportPaths(content) : "");

              const key = `${path}?id=${scriptId++}`;
              if (contents.includes("import.meta.glob")) {
                scripts[key] = {
                  loader: "js",
                  contents: await doTransformGlobImport(contents, path, loader),
                  pluginData: {
                    htmlType: { loader },
                  },
                };
              } else {
                scripts[key] = {
                  loader,
                  contents,
                  pluginData: {
                    htmlType: { loader },
                  },
                };
              }

              const virtualModulePath = JSON.stringify(
                virtualModulePrefix + key
              );

              const contextMatch = openTag.match(contextRE);
              const context =
                contextMatch &&
                (contextMatch[1] || contextMatch[2] || contextMatch[3]);

              if (path.endsWith(".svelte") && context !== "module") {
                js += `import ${virtualModulePath}\n`;
              } else {
                js += `export * from ${virtualModulePath}\n`;
              }
            }
          }

          if (!path.endsWith(".vue") || !js.includes("export default")) {
            js += "\nexport default {}";
          }

          return {
            loader: "js",
            contents: js,
          };
        }
      );

      build.onResolve(
        {
          filter: /^[\w@][^:]/,
        },
        async ({ path: id, importer, pluginData }) => {
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id });
          }
          if (depImports[id]) {
            return externalUnlessEntry({ path: id });
          }
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          });
          if (resolved) {
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id });
            }
            if (isInNodeModules(resolved) || include?.includes(id)) {
              if (isOptimizable(resolved, config.optimizeDeps)) {
                depImports[id] = resolved;
              }
              return externalUnlessEntry({ path: id });
            } else if (isScannable(resolved)) {
              const namespace = htmlTypesRE.test(resolved) ? "html" : undefined;
              return {
                path: path.resolve(resolved),
                namespace,
              };
            } else {
              return externalUnlessEntry({ path: id });
            }
          } else {
            missing[id] = normalizePath(importer);
          }
        }
      );

      build.onResolve({ filter: CSS_LANGS_RE }, externalUnlessEntry);

      build.onResolve({ filter: /\.(json|json5|wasm)$/ }, externalUnlessEntry);

      build.onResolve(
        {
          filter: new RegExp(`\\.(${KNOWN_ASSET_TYPES.join("|")})$`),
        },
        externalUnlessEntry
      );

      build.onResolve({ filter: SPECIAL_QUERY_RE }, ({ path }) => ({
        path,
        external: true,
      }));

      build.onResolve(
        {
          filter: /.*/,
        },
        async ({ path: id, importer, pluginData }) => {
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          });
          if (resolved) {
            if (shouldExternalizeDep(resolved, id) || !isScannable(resolved)) {
              return externalUnlessEntry({ path: id });
            }

            const namespace = htmlTypesRE.test(resolved) ? "html" : undefined;

            return {
              path: path.resolve(cleanUrl(resolved)),
              namespace,
            };
          } else {
            return externalUnlessEntry({ path: id });
          }
        }
      );

      build.onLoad({ filter: JS_TYPES_RE }, async ({ path: id }) => {
        let ext = path.extname(id).slice(1);
        if (ext === "mjs") ext = "js";

        let contents = await fsp.readFile(id, "utf-8");
        if (ext.endsWith("x") && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents;
        }

        const loader =
          config.optimizeDeps?.esbuildOptions?.loader?.[`.${ext}`] ||
          (ext as Loader);

        if (contents.includes("import.meta.glob")) {
          return {
            loader: "js",
            contents: await doTransformGlobImport(contents, id, loader),
          };
        }

        return {
          loader,
          contents,
        };
      });
    },
  };
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps);
  depsList.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(depsList);
}
/**找出入口文件 */
async function computeEntries(config: ResolvedConfig) {
  return await globEntries("**/*.html", config);
}
function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      "**/node_modules/**",
      `**/${config.build.outDir}/**`,
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true,
    suppressErrors: true,
  });
}

async function prepareEsbuildScanner(
  config: ResolvedConfig,
  entries: string[],
  deps: Record<string, string>,
  missing: Record<string, string>,
  _scanContext?: { cancelled: boolean }
): Promise<BuildContext | undefined> {
  const container = await createPluginContainer(config);
  const plugin = esbuildScanPlugin(config, container, deps, missing, entries);
  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {};

  return await esbuild.context({
    absWorkingDir: process.cwd(),
    write: false,
    stdin: {
      contents: entries.map((e) => `import ${JSON.stringify(e)}`).join("\n"),
      loader: "js",
    },
    bundle: true,
    format: "esm",
    logLevel: "silent",
    plugins: [...plugins, plugin],
    ...esbuildOptions,
  });
}

function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, "/* */")
    .replace(singlelineCommentsRE, "");

  let js = "";
  let m;
  importsRE.lastIndex = 0;
  while ((m = importsRE.exec(code)) != null) {
    js += `\nimport ${m[1]}`;
  }
  return js;
}

function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  if (!path.isAbsolute(resolvedId)) {
    return true;
  }
  if (resolvedId === rawId || resolvedId.includes("\0")) {
    return true;
  }
  return false;
}

function isScannable(id: string): boolean {
  return JS_TYPES_RE.test(id) || htmlTypesRE.test(id);
}
