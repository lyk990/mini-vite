import { ViteDevServer } from "..";
import type { Connect } from "dep-types/connect";

export function indexHtmlMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  return async function viteIndexHtmlMiddleware(req, res, next) {
    console.log(req, "req");
    console.log(res, "res");
    console.log(next, "next");
    const result = await server.transformIndexHtml(url, html, req.originalUrl);
  };
}

