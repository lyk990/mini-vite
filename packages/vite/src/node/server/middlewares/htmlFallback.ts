import fs from "node:fs";
import path from "node:path";
import history from "connect-history-api-fallback";
import type { Connect } from "dep-types/connect";
import { createDebugger } from "../../utils";
/**拦截无法匹配的URL请求，并将默认的入口HTML文件返回给浏览器 */
export function htmlFallbackMiddleware(
  root: string
): Connect.NextHandleFunction {
  const historyHtmlFallbackMiddleware = history({
    logger: createDebugger("vite:html-fallback"),
    rewrites: [
      {
        from: /\/$/,
        to({ parsedUrl, request }: any) {
          const rewritten =
            decodeURIComponent(parsedUrl.pathname) + "index.html";

          if (fs.existsSync(path.join(root, rewritten))) {
            return rewritten;
          }

          return `/index.html`;
        },
      },
    ],
  });

  return function viteHtmlFallbackMiddleware(req, res, next) {
    return historyHtmlFallbackMiddleware(req, res, next);
  };
}
