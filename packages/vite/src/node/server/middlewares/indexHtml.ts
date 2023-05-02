import { ViteDevServer } from "..";
import type { Connect } from "dep-types/connect";
import { cleanUrl, fsPathFromId, normalizePath } from "../../utils";
import { FS_PREFIX } from "../../constants";
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { send } from "../send";

export function indexHtmlMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      return next();
    }

    const url = req.url && cleanUrl(req.url);
    // htmlFallbackMiddleware appends '.html' to URLs
    if (url?.endsWith(".html") && req.headers["sec-fetch-dest"] !== "script") {
      const filename = getHtmlFilename(url, server);
      if (fs.existsSync(filename)) {
        try {
          let html = await fsp.readFile(filename, "utf-8");
          html = await server.transformIndexHtml(url, html, req.originalUrl);
          return send(req, res, html, "html", {
            headers: server.config.server.headers,
          });
        } catch (e) {
          return next(e);
        }
      }
    }
    next();
  };
}

function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url));
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1)))
    );
  }
}
