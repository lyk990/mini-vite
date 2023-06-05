import type { Connect } from "dep-types/connect";
import { transformRequest } from "../transformRequest";
import { send } from "vite";
import {
  isCSSRequest,
  isDirectCSSRequest,
  isDirectRequest,
} from "../../plugins/css";
import {
  createDebugger,
  injectQuery,
  isImportRequest,
  isJSRequest,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  unwrapId,
} from "../../utils";
import { DEP_VERSION_RE, NULL_BYTE_PLACEHOLDER } from "../../constants";
import { ViteDevServer } from "../..";
import { isHTMLProxy } from "../../plugins/html";

const knownIgnoreList = new Set(["/", "/favicon.ico"]);
const debugCache = createDebugger("vite:cache");
/**transform核心中间件，可以拦截请求，修改请求URL、添加请求头 */
export function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  const {
    config: { root, logger },
    moduleGraph,
  } = server;

  return async function viteTransformMiddleware(req, res, next) {
    if (req.method !== "GET" || knownIgnoreList.has(req.url!)) {
      return next();
    }

    let url: string;
    try {
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER,
        "\0"
      );
    } catch (e) {
      return next(e);
    }

    try {
      if (
        isJSRequest(url) ||
        isImportRequest(url) ||
        isCSSRequest(url) ||
        isHTMLProxy(url)
      ) {
        url = removeImportQuery(url);
        url = unwrapId(url);
        if (
          isCSSRequest(url) &&
          !isDirectRequest(url) &&
          req.headers.accept?.includes("text/css")
        ) {
          url = injectQuery(url, "direct");
        }

        const ifNoneMatch = req.headers["if-none-match"];
        if (
          ifNoneMatch &&
          (await moduleGraph.getModuleByUrl(url))?.transformResult?.etag ===
            ifNoneMatch
        ) {
          debugCache?.(`[304] ${prettifyUrl(url, root)}`);
          res.statusCode = 304;
          return res.end();
        }

        const result = await transformRequest(url, server, {
          html: req.headers.accept?.includes("text/html"),
        });
        if (result) {
          const type = isDirectCSSRequest(url) ? "css" : "js";
          const isDep = DEP_VERSION_RE.test(url);
          return send(req, res, result.code, type, {
            etag: result.etag,
            cacheControl: isDep ? "max-age=31536000,immutable" : "no-cache",
            headers: server.config.server.headers,
            map: result.map,
          });
        }
      }
    } catch (e) {
      logger.error("transform error: " + e.message);
      return next(e);
    }

    next();
  };
}
