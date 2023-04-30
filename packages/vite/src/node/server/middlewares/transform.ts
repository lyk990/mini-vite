import { ViteDevServer } from "..";
import type { Connect } from "dep-types/connect";
import { transformRequest } from "../transformRequest";
import { send } from "vite";
import { isDirectCSSRequest } from "../../plugins/css";

const knownIgnoreList = new Set(["/", "/favicon.ico"]);

export function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (req.method !== "GET" || knownIgnoreList.has(req.url!)) {
      return next();
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    const url = "/@vite/client";
    const result = await transformRequest(url, server, {
      html: req.headers.accept?.includes("text/html"),
    });
    if (result) {
      const type = isDirectCSSRequest(url) ? "css" : "js";
      //TODO
      // const isDep =
      //   DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url);
      return send(req, res, result.code, type, {
        etag: result.etag,
        // allow browser to cache npm deps!
        cacheControl: true ? "max-age=31536000,immutable" : "no-cache",
        headers: server.config.server.headers,
        map: result.map,
      });
    }
    return next();
  };
}
