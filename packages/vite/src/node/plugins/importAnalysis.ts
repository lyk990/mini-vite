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
  //clientPublicPath = @vite/client
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
      // 用于存储导入的 URL,利用set去重
      const importedUrls = new Set<string>();
      let isPartiallySelfAccepting = false;
      // 用于存储导入的绑定信息
      const importedBindings = null;
      // 将 URL 转换为绝对路径
      const toAbsoluteUrl = (url: string) =>
        path.posix.resolve(path.posix.dirname(importerModule.url), url);
      // 解析出对应的绝对路径
      const normalizeUrl = async (
        url: string,
        pos: number,
        forceSkipImportAnalysis: boolean = false
      ): Promise<[string, string]> => {
        // 移除基础路径config.base
        url = stripBase(url, base);

        let importerFile = importer;
        const resolved = await this.resolve(url, importerFile);

        if (!resolved) {
          return this.error(`Failed to resolve import`);
        }
        // 如果resolved.id以 root + "/" 开头，
        // 说明是绝对路径，将 url 更新为相对于 root 的路径
        if (resolved.id.startsWith(root + "/")) {
          url = resolved.id.slice(root.length);
          // 如果resolved.id 在文件系统中存在（使用 fs.existsSync 判断），
          // 则将 url 更新为使用 FS_PREFIX 拼接解析结果的 ID
        } else if (fs.existsSync(cleanUrl(resolved.id))) {
          url = path.posix.join(FS_PREFIX, resolved.id);
        } else {
          url = resolved.id;
        }

        if (url[0] !== "." && url[0] !== "/") {
          // 给id加上前缀`/@id/`
          url = wrapId(resolved.id);
        }
        // 判断是否需要在url上添加查询参数`?import`
        url = markExplicitImport(url);
        try {
          // 将当前文件id存储到idToModuleMap中
          const depModule = await moduleGraph._ensureEntryFromUrl(
            unwrapId(url),
            canSkipImportAnalysis(url) || forceSkipImportAnalysis,
            resolved
          );
          // 模块发生更新时，更新url上的时间戳参数
          // 避免浏览器使用旧的缓存内容，确保获取到最新的模块代码
          if (depModule.lastHMRTimestamp > 0) {
            url = injectQuery(url, `t=${depModule.lastHMRTimestamp}`);
          }
        } catch (e: any) {
          e.pos = pos;
          throw e;
        }
        // 将base和url组合起来
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
        // 文件中所有的import已经被parseImports方法收集到imports里面了
        imports.map(async (importSpecifier, index) => {
          const {
            s: start,
            e: end,
            d: dynamicIndex,
            n: specifier,
          } = importSpecifier;

          const rawUrl = source.slice(start, end);
          // import.meta是一个给 JavaScript 模块暴露特定上下文的元数据属性的对象。
          // 它包含了这个模块的信息,它带有一个null的原型对象。这个对象可以扩展
          if (rawUrl === "import.meta") {
            const prop = source.slice(end, end + 4);
            // 判断是否有热更新需求
            if (prop === ".hot") {
              hasHMR = true;
              const endHot = end + 4 + (source[end + 4] === "?" ? 1 : 0);
              // import.meta.accept用于控制模块是否接受热替换的机制。
              if (source.slice(endHot, endHot + 7) === ".accept") {
                const importAcceptedUrls = (orderedAcceptedUrls[index] =
                  new Set<UrlPosition>());
                // 调用lexAcceptedHmrDeps解析得到模块路径和位置
                // 同时判断模块是否能热更新
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
          // 是否有imports导入模块路径
          if (specifier) {
            // 如果导入路径与 clientPublicPath（@vite/client） 相同，
            // 直接返回，不进行后续处理，因为@vite/client已经做过处理了
            if (specifier === clientPublicPath) {
              return;
            }
            // TODO url为什么要这样解析
            const [url] = await normalizeUrl(specifier, start);

            server?.moduleGraph.safeModulesPath.add(fsPathFromUrl(url));
            // 解析得到的 URL 与原始导入路径 specifier 不同，
            // 说明进行了重写操作，将原始导入路径替换为规范化后的 URL
            if (url !== specifier) {
              const rewrittenUrl = JSON.stringify(url);
              const s = isDynamicImport ? start : start - 1;
              const e = isDynamicImport ? end : end + 1;
              str().overwrite(s, e, rewrittenUrl, {
                contentOnly: true,
              });
            }

            const hmrUrl = unwrapId(stripBase(url, base));
            // 判断是否是外部链接引入的url
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
      // 去重
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
      // 处理url,并替换原始字符串中对应的部分
      const normalizedAcceptedUrls = new Set<string>();
      for (const { url, start, end } of acceptedUrls) {
        const [normalized] = await moduleGraph.resolveUrl(toAbsoluteUrl(url));
        normalizedAcceptedUrls.add(normalized);
        str().overwrite(start, end, JSON.stringify(normalized), {
          contentOnly: true, // 表示仅替换内容部分
        });
      }
      // TODO css文件在热更新中是怎么被处理的
      // CSS 在构建过程中通常会被提取出来，
      // 并以独立的方式加载到页面中，而不是通过模块系统进行导入和解析
      if (!isCSSRequest(importer)) {
        // 更新当前模块的相关信息，包括导入的 URL、导入的绑定、接受的 URL
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
/**是否是本地导入 */
export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(cleanUrl(url)) && !isCSSRequest(url);
}
// NOTE 动态加载是为了解决什么问题
/**
 * url = '/src/assets/vue.svg?import'
 * 在URL上注入查询参数 "import" ，作为标记
 * 判断根据条件是否动态加载
 * */
function markExplicitImport(url: string) {
  if (isExplicitImportRequired(url)) {
    return injectQuery(url, "import");
  }
  return url;
}

/**url去重 */
function mergeAcceptedUrls<T>(orderedUrls: Array<Set<T> | undefined>) {
  const acceptedUrls = new Set<T>();
  for (const urls of orderedUrls) {
    if (!urls) continue;
    for (const url of urls) acceptedUrls.add(url);
  }
  return acceptedUrls;
}
