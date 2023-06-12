import { CLIENT_PUBLIC_PATH, FS_PREFIX } from "../constants";
import {
  cleanUrl,
  fsPathFromUrl,
  injectQuery,
  isDataUrl,
  isExternalUrl,
  isJSRequest,
  joinUrlSegments,
  removeImportQuery,
  stripBase,
  stripBomTag,
  unwrapId,
  wrapId,
  transformStableResult,
} from "../utils";
import path from "node:path";
import { ViteDevServer } from "../server";
import { Plugin } from "../plugin";
import { ImportSpecifier } from "es-module-lexer";
import MagicString from "magic-string";
import { ResolvedConfig } from "../config";
import { lexAcceptedHmrDeps, normalizeHmrUrl } from "../server/hmr";
import { isCSSRequest, isDirectCSSRequest } from "./css";
import { init, parse as parseImports } from "es-module-lexer";
import fs from "node:fs";

const skipRE = /\.(?:map|json)(?:$|\?)/;
export const canSkipImportAnalysis = (id: string): boolean =>
  skipRE.test(id) || isDirectCSSRequest(id);

interface UrlPosition {
  url: string;
  start: number;
  end: number;
}

export function importAnalysisPlugin(config: ResolvedConfig): Plugin {
  const { root, base } = config;
  const clientPublicPath = path.posix.join(base, CLIENT_PUBLIC_PATH);
  let server: ViteDevServer;

  return {
    name: "vite:import-analysis",

    configureServer(_server) {
      server = _server;
    },

    async transform(source, importer) {
      if (!server) {
        return null;
      }

      // NOTE
      // 在使用 es-module-lexer 之前，
      // 必须先调用 init 函数进行初始化，确保解析器正常工作。
      // 可用于加载WebAssembly 模块（使用 WebAssembly 字节码编译的二进制文件）
      // es-module-lexer 使用 WebAssembly 来解析和分析JavaScript 模块中的 import 和 export 语句。
      // 并提取相关的模块信息，如导入的模块路径、导出的标识符等
      await init;
      let imports!: readonly ImportSpecifier[];
      source = stripBomTag(source);
      try {
        // 通过es-module-lexer提取导入导出代码信息
        [imports, exports] = parseImports(source);
      } catch (e: any) {
        this.error(
          `Failed to parse source for import analysis because the content ` +
            `contains invalid JS syntax. ` +
            e.idx
        );
      }

      const { moduleGraph } = server;
      // 从idToModuleMap中找到对应的模块节点
      const importerModule = moduleGraph.getModuleById(importer)!;
      // 如果没有导入语句且没有添加过导入项
      // 则将当前模块的 isSelfAccepting 标志设为 false，并打印相关信息。
      if (!imports.length && !(this as any)._addedImports) {
        importerModule.isSelfAccepting = false;
        return source;
      }

      let hasHMR = false;
      let isSelfAccepting = false;
      // 用于处理源代码的字符串操作
      let s: MagicString | undefined;
      const str = () => s || (s = new MagicString(source));
      // 用于存储导入的 URL
      const importedUrls = new Set<string>();
      let isPartiallySelfAccepting = false;
      const importedBindings = null;
      const toAbsoluteUrl = (url: string) =>
        path.posix.resolve(path.posix.dirname(importerModule.url), url);

      const normalizeUrl = async (
        url: string,
        pos: number,
        forceSkipImportAnalysis: boolean = false
      ): Promise<[string, string]> => {
        url = stripBase(url, base);

        let importerFile = importer;
        const resolved = await this.resolve(url, importerFile);

        if (!resolved) {
          return this.error(`Failed to resolve import`);
        }

        if (resolved.id.startsWith(root + "/")) {
          url = resolved.id.slice(root.length);
        } else if (fs.existsSync(cleanUrl(resolved.id))) {
          url = path.posix.join(FS_PREFIX, resolved.id);
        } else {
          url = resolved.id;
        }

        if (url[0] !== "." && url[0] !== "/") {
          url = wrapId(resolved.id);
        }
        url = markExplicitImport(url);
        try {
          const depModule = await moduleGraph._ensureEntryFromUrl(
            unwrapId(url),
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
            d: dynamicIndex,
            n: specifier,
          } = importSpecifier;

          const rawUrl = source.slice(start, end);

          if (rawUrl === "import.meta") {
            const prop = source.slice(end, end + 4);
            if (prop === ".hot") {
              hasHMR = true;
              const endHot = end + 4 + (source[end + 4] === "?" ? 1 : 0);
              if (source.slice(endHot, endHot + 7) === ".accept") {
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
            return;
          }

          const isDynamicImport = dynamicIndex > -1;

          if (specifier) {
            if (specifier === clientPublicPath) {
              return;
            }
            const [url] = await normalizeUrl(specifier, start);

            server?.moduleGraph.safeModulesPath.add(fsPathFromUrl(url));

            if (url !== specifier) {
              let rewriteDone = false;
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

            if (
              !isDynamicImport &&
              isLocalImport &&
              config.server.preTransformRequests
            ) {
              const url = removeImportQuery(hmrUrl);
              server.transformRequest(url).catch((e) => {
                config.logger.error(e.message);
              });
            }
          }
        })
      );

      const acceptedUrls = mergeAcceptedUrls(orderedAcceptedUrls);
      const acceptedExports = mergeAcceptedUrls(orderedAcceptedExports);

      if (hasHMR) {
        // 注入热更新代码
        // import.meta.hot = __vite__createHotContext("/src/Index.vue");
        str().prepend(
          `import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";` +
            `import.meta.hot = __vite__createHotContext(${JSON.stringify(
              normalizeHmrUrl(importerModule.url)
            )});`
        );
      }

      const normalizedAcceptedUrls = new Set<string>();
      for (const { url, start, end } of acceptedUrls) {
        const [normalized] = await moduleGraph.resolveUrl(toAbsoluteUrl(url));
        normalizedAcceptedUrls.add(normalized);
        str().overwrite(start, end, JSON.stringify(normalized), {
          contentOnly: true,
        });
      }

      if (!isCSSRequest(importer)) {
        await moduleGraph.updateModuleInfo(
          importerModule,
          importedUrls,
          importedBindings,
          normalizedAcceptedUrls,
          isPartiallySelfAccepting ? acceptedExports : null,
          isSelfAccepting
        );
      }

      if (s) {
        return transformStableResult(s);
      } else {
        return source;
      }
    },
  };
}

export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(cleanUrl(url)) && !isCSSRequest(url);
}

function markExplicitImport(url: string) {
  if (isExplicitImportRequired(url)) {
    return injectQuery(url, "import");
  }
  return url;
}

function mergeAcceptedUrls<T>(orderedUrls: Array<Set<T> | undefined>) {
  const acceptedUrls = new Set<T>();
  for (const urls of orderedUrls) {
    if (!urls) continue;
    for (const url of urls) acceptedUrls.add(url);
  }
  return acceptedUrls;
}
