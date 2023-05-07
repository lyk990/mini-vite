import { isCSSRequest } from "vite";
import {
  BARE_IMPORT_RE,
  CLIENT_PUBLIC_PATH,
  DEP_VERSION_RE,
  FS_PREFIX,
} from "../constants";
import {
  cleanUrl,
  getShortName,
  isExternalUrl,
  isJSRequest,
  normalizePath,
  stripBase,
  stripBomTag,
  wrapId,
} from "../utils";
import path from "node:path";
import { ServerContext, ViteDevServer } from "../server";
import { Plugin } from "../plugin";
import { ExportSpecifier, ImportSpecifier } from "es-module-lexer";
import MagicString from "magic-string";
import { ResolvedConfig } from "../config";
import { normalizeHmrUrl } from "../server/hmr";
import { isDirectCSSRequest } from "./css";
import { init, parse as parseImports } from "es-module-lexer";
import { getDepsOptimizer, optimizedDepNeedsInterop } from "../optimizer";

const skipRE = /\.(?:map|json)(?:$|\?)/;
export const canSkipImportAnalysis = (id: string): boolean =>
  skipRE.test(id) || isDirectCSSRequest(id);
  
// TODO 未完成
export function importAnalysisPlugin(config: ResolvedConfig): Plugin {
  const { root, base } = config;
  const clientPublicPath = path.posix.join(base, CLIENT_PUBLIC_PATH);
  const enablePartialAccept = config.experimental?.hmrPartialAccept;
  let server: ViteDevServer;

  let _env: string | undefined;
  function getEnv(ssr: boolean) {
    if (!_env) {
      _env = `import.meta.env = ${JSON.stringify({
        ...config.env,
        SSR: "__vite__ssr__",
      })};`;
      for (const key in config.define) {
        if (key.startsWith(`import.meta.env.`)) {
          const val = config.define[key];
          _env += `${key} = ${
            typeof val === "string" ? val : JSON.stringify(val)
          };`;
        }
      }
    }
    return _env.replace('"__vite__ssr__"', ssr + "");
  }

  return {
    name: "vite:import-analysis",

    configureServer(_server) {
      server = _server;
    },

    async transform(source, importer, options) {
      if (!server) {
        return null;
      }

      const ssr = false;

      if (canSkipImportAnalysis(importer)) {
        return null;
      }

      await init;
      let imports!: readonly ImportSpecifier[];
      let exports!: readonly ExportSpecifier[];
      source = stripBomTag(source);
      try {
        [imports, exports] = parseImports(source);
      } catch (e: any) {
        console.log(e);
      }

      const depsOptimizer = getDepsOptimizer(config, ssr);

      const { moduleGraph } = server;
      const importerModule = moduleGraph.getModuleById(importer)!;
      if (!importerModule && depsOptimizer?.isOptimizedDepFile(importer)) {
        throwOutdatedRequest(importer);
      }

      if (!imports.length && !(this as any)._addedImports) {
        importerModule.isSelfAccepting = false;
        return source;
      }

      let hasHMR = false;
      let isSelfAccepting = false;
      let hasEnv = false;
      let needQueryInjectHelper = false;
      let s: MagicString | undefined;
      const str = () => s || (s = new MagicString(source));
      const importedUrls = new Set<string>();
      let isPartiallySelfAccepting = false;
      const importedBindings = enablePartialAccept
        ? new Map<string, Set<string>>()
        : null;
      const toAbsoluteUrl = (url: string) =>
        path.posix.resolve(path.posix.dirname(importerModule.url), url);

      const normalizeUrl = async (
        url: string,
        pos: number,
        forceSkipImportAnalysis: boolean = false
      ): Promise<[string, string]> => {
        url = stripBase(url, base);

        let importerFile = importer;

        const optimizeDeps = getDepOptimizationConfig(config, ssr);
        if (moduleListContains(optimizeDeps?.exclude, url)) {
          if (depsOptimizer) {
            await depsOptimizer.scanProcessing;

            for (const optimizedModule of depsOptimizer.metadata.depInfoList) {
              if (!optimizedModule.src) continue;
              if (optimizedModule.file === importerModule.file) {
                importerFile = optimizedModule.src;
              }
            }
          }
        }

        const resolved = await this.resolve(url, importerFile);

        if (!resolved) {
          if (ssr) {
            return [url, url];
          }
          importerModule.isSelfAccepting = false;
          return this.error(
            `Failed to resolve import "${url}" from "${path.relative(
              process.cwd(),
              importerFile
            )}". Does the file exist?`,
            pos
          );
        }

        const isRelative = url[0] === ".";
        const isSelfImport =
          !isRelative && cleanUrl(url) === cleanUrl(importer);

        if (resolved.id.startsWith(root + "/")) {
          url = resolved.id.slice(root.length);
        } else if (
          depsOptimizer?.isOptimizedDepFile(resolved.id) ||
          fs.existsSync(cleanUrl(resolved.id))
        ) {
          url = path.posix.join(FS_PREFIX, resolved.id);
        } else {
          url = resolved.id;
        }

        if (isExternalUrl(url)) {
          return [url, url];
        }

        if (url[0] !== "." && url[0] !== "/") {
          url = wrapId(resolved.id);
        }

        if (!ssr) {
          url = markExplicitImport(url);

          if (
            (isRelative || isSelfImport) &&
            !hasImportInQueryParamsRE.test(url) &&
            !url.match(DEP_VERSION_RE)
          ) {
            const versionMatch = importer.match(DEP_VERSION_RE);
            if (versionMatch) {
              url = injectQuery(url, versionMatch[1]);
            }
          }

          try {
            const depModule = await moduleGraph._ensureEntryFromUrl(
              unwrapId(url),
              ssr,
              canSkipImportAnalysis(url) || forceSkipImportAnalysis,
              resolved
            );
            if (depModule.lastHMRTimestamp > 0) {
              url = injectQuery(url, `t=${depModule.lastHMRTimestamp}`);
            }
          } catch (e: any) {
            e.pos = pos;
            throw e;
          }

          url = joinUrlSegments(base, url);
        }

        return [url, resolved.id];
      };

      const orderedAcceptedUrls = new Array<Set<UrlPosition> | undefined>(
        imports.length
      );
      const orderedAcceptedExports = new Array<Set<string> | undefined>(
        imports.length
      );

      await Promise.all(
        imports.map(async (importSpecifier, index) => {
          const {
            s: start,
            e: end,
            ss: expStart,
            se: expEnd,
            d: dynamicIndex,
            n: specifier,
            a: assertIndex,
          } = importSpecifier;

          const rawUrl = source.slice(start, end);

          if (rawUrl === "import.meta") {
            const prop = source.slice(end, end + 4);
            if (prop === ".hot") {
              hasHMR = true;
              const endHot = end + 4 + (source[end + 4] === "?" ? 1 : 0);
              if (source.slice(endHot, endHot + 7) === ".accept") {
                if (source.slice(endHot, endHot + 14) === ".acceptExports") {
                  const importAcceptedExports = (orderedAcceptedExports[index] =
                    new Set<string>());
                  lexAcceptedHmrExports(
                    source,
                    source.indexOf("(", endHot + 14) + 1,
                    importAcceptedExports
                  );
                  isPartiallySelfAccepting = true;
                } else {
                  const importAcceptedUrls = (orderedAcceptedUrls[index] =
                    new Set<UrlPosition>());
                  if (
                    lexAcceptedHmrDeps(
                      source,
                      source.indexOf("(", endHot + 7) + 1,
                      importAcceptedUrls
                    )
                  ) {
                    isSelfAccepting = true;
                  }
                }
              }
            } else if (prop === ".env") {
              hasEnv = true;
            }
            return;
          }

          const isDynamicImport = dynamicIndex > -1;

          if (!isDynamicImport && assertIndex > -1) {
            str().remove(end + 1, expEnd);
          }

          if (specifier) {
            if (isExternalUrl(specifier) || isDataUrl(specifier)) {
              return;
            }
            if (ssr) {
              if (config.legacy?.buildSsrCjsExternalHeuristics) {
                if (
                  cjsShouldExternalizeForSSR(specifier, server._ssrExternals)
                ) {
                  return;
                }
              } else if (shouldExternalizeForSSR(specifier, config)) {
                return;
              }
              if (isBuiltin(specifier)) {
                return;
              }
            }
            // skip client
            if (specifier === clientPublicPath) {
              return;
            }

            if (
              specifier[0] === "/" &&
              !config.assetsInclude(cleanUrl(specifier)) &&
              !specifier.endsWith(".json") &&
              checkPublicFile(specifier, config)
            ) {
              throw new Error(
                `Cannot import non-asset file ${specifier} which is inside /public.` +
                  `JS/CSS files inside /public are copied as-is on build and ` +
                  `can only be referenced via <script src> or <link href> in html.`
              );
            }

            // normalize
            const [url, resolvedId] = await normalizeUrl(specifier, start);

            server?.moduleGraph.safeModulesPath.add(fsPathFromUrl(url));

            if (url !== specifier) {
              let rewriteDone = false;
              if (
                depsOptimizer?.isOptimizedDepFile(resolvedId) &&
                !resolvedId.match(optimizedDepChunkRE)
              ) {
                const file = cleanUrl(resolvedId);

                const needsInterop = await optimizedDepNeedsInterop(
                  depsOptimizer.metadata,
                  file,
                  config,
                  ssr
                );

                if (needsInterop === undefined) {
                } else if (needsInterop) {
                  interopNamedImports(
                    str(),
                    importSpecifier,
                    url,
                    index,
                    importer,
                    config
                  );
                  rewriteDone = true;
                }
              } else if (
                url.includes(browserExternalId) &&
                source.slice(expStart, start).includes("{")
              ) {
                interopNamedImports(
                  str(),
                  importSpecifier,
                  url,
                  index,
                  importer,
                  config
                );
                rewriteDone = true;
              }
              if (!rewriteDone) {
                const rewrittenUrl = JSON.stringify(url);
                const s = isDynamicImport ? start : start - 1;
                const e = isDynamicImport ? end : end + 1;
                str().overwrite(s, e, rewrittenUrl, {
                  contentOnly: true,
                });
              }
            }

            const hmrUrl = unwrapId(stripBase(url, base));
            const isLocalImport = !isExternalUrl(hmrUrl) && !isDataUrl(hmrUrl);
            if (isLocalImport) {
              importedUrls.add(hmrUrl);
            }

            if (enablePartialAccept && importedBindings) {
              extractImportedBindings(
                resolvedId,
                source,
                importSpecifier,
                importedBindings
              );
            }

            if (
              !isDynamicImport &&
              isLocalImport &&
              config.server.preTransformRequests
            ) {
              const url = removeImportQuery(hmrUrl);
              server.transformRequest(url, { ssr }).catch((e) => {
                if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
                  // This are expected errors
                  return;
                }
                // Unexpected error, log the issue but avoid an unhandled exception
                config.logger.error(e.message);
              });
            }
          } else if (!importer.startsWith(clientDir)) {
            if (!ssr) {
              const url = rawUrl.replace(cleanUpRawUrlRE, "").trim();
              if (
                !urlIsStringRE.test(url) ||
                isExplicitImportRequired(url.slice(1, -1))
              ) {
                needQueryInjectHelper = true;
                str().overwrite(
                  start,
                  end,
                  `__vite__injectQuery(${url}, 'import')`,
                  { contentOnly: true }
                );
              }
            }
          }
        })
      );

      const acceptedUrls = mergeAcceptedUrls(orderedAcceptedUrls);
      const acceptedExports = mergeAcceptedUrls(orderedAcceptedExports);

      if (hasEnv) {
        // inject import.meta.env
        str().prepend(getEnv(ssr));
      }

      if (hasHMR && !ssr) {
        // inject hot context
        str().prepend(
          `import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";` +
            `import.meta.hot = __vite__createHotContext(${JSON.stringify(
              normalizeHmrUrl(importerModule.url)
            )});`
        );
      }

      if (needQueryInjectHelper) {
        str().prepend(
          `import { injectQuery as __vite__injectQuery } from "${clientPublicPath}";`
        );
      }

      const normalizedAcceptedUrls = new Set<string>();
      for (const { url, start, end } of acceptedUrls) {
        const [normalized] = await moduleGraph.resolveUrl(
          toAbsoluteUrl(url),
          ssr
        );
        normalizedAcceptedUrls.add(normalized);
        str().overwrite(start, end, JSON.stringify(normalized), {
          contentOnly: true,
        });
      }

      if (!isCSSRequest(importer)) {
        const pluginImports = (this as any)._addedImports as
          | Set<string>
          | undefined;
        if (pluginImports) {
          (
            await Promise.all(
              [...pluginImports].map((id) => normalizeUrl(id, 0, true))
            )
          ).forEach(([url]) => importedUrls.add(url));
        }

        if (ssr && importerModule.isSelfAccepting) {
          isSelfAccepting = true;
        }

        if (
          !isSelfAccepting &&
          isPartiallySelfAccepting &&
          acceptedExports.size >= exports.length &&
          exports.every((e) => acceptedExports.has(e.n))
        ) {
          isSelfAccepting = true;
        }
        const prunedImports = await moduleGraph.updateModuleInfo(
          importerModule,
          importedUrls,
          importedBindings,
          normalizedAcceptedUrls,
          isPartiallySelfAccepting ? acceptedExports : null,
          isSelfAccepting,
          ssr
        );
        if (hasHMR && prunedImports) {
          handlePrunedModules(prunedImports, server);
        }
      }

      if (s) {
        return transformStableResult(s, importer, config);
      } else {
        return source;
      }
    },
  };
}

export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(cleanUrl(url)) && !isCSSRequest(url);
}
