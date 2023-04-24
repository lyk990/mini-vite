import { ViteDevServer } from "..";
import type { Connect } from "dep-types/connect";

export function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (req.url === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      const result = await server.transformIndexHtml(
        url,
        html,
        req.originalUrl
      );
    }
    return next();
  };
}
