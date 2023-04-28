import { ViteDevServer } from "..";
import type { Connect } from "dep-types/connect";
import { transformRequest } from "../transformRequest";

export function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (req.url === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      const url = "/@vite/client";
      const result = await transformRequest(url, server, {
        html: req.headers.accept?.includes("text/html"),
      });
    }
    return next();
  };
}
