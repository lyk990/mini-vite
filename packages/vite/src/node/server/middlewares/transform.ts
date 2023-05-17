import type { Connect } from "dep-types/connect";
import { ERR_LOAD_URL, transformRequest } from "../transformRequest";
import { send } from "vite";
import {
  isCSSRequest,
  isDirectCSSRequest,
  isDirectRequest,
} from "../../plugins/css";
import {
  cleanUrl,
  createDebugger,
  fsPathFromId,
  injectQuery,
  isImportRequest,
  isJSRequest,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  unwrapId,
} from "../../utils";
import {
  DEP_VERSION_RE,
  FS_PREFIX,
  NULL_BYTE_PLACEHOLDER,
} from "../../constants";
import path from "node:path";
import fsp from "node:fs/promises";
import type { ExistingRawSourceMap } from "rollup";
import colors from "picocolors";
import {
  ERR_OPTIMIZE_DEPS_PROCESSING_ERROR,
  ERR_OUTDATED_OPTIMIZED_DEP,
} from "../../plugins/optimizedDeps";
import { getDepsOptimizer } from "../../optimizer/optimizer";
import { ViteDevServer } from "../..";
import { applySourcemapIgnoreList } from "../sourcemap";
import { isHTMLProxy } from "../../plugins/html";

const knownIgnoreList = new Set(["/", "/favicon.ico"]);
const debugCache = createDebugger("vite:cache");

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
      console.log(e);
      return next(e);
    }

    const withoutQuery = cleanUrl(url);

    try {
      const isSourceMap = withoutQuery.endsWith(".map");
      if (isSourceMap) {
        const depsOptimizer = getDepsOptimizer(server.config, false); // non-ssr
        if (depsOptimizer?.isOptimizedDepUrl(url)) {
          const sourcemapPath = url.startsWith(FS_PREFIX)
            ? fsPathFromId(url)
            : normalizePath(path.resolve(root, url.slice(1)));
          try {
            const map = JSON.parse(
              await fsp.readFile(sourcemapPath, "utf-8")
            ) as ExistingRawSourceMap;

            applySourcemapIgnoreList(
              map,
              sourcemapPath,
              server.config.server.sourcemapIgnoreList,
              logger
            );

            return send(req, res, JSON.stringify(map), "json", {
              headers: server.config.server.headers,
            });
          } catch (e) {
            console.log(e);
            const dummySourceMap = {
              version: 3,
              file: sourcemapPath.replace(/\.map$/, ""),
              sources: [],
              sourcesContent: [],
              names: [],
              mappings: ";;;;;;;;;",
            };
            return send(req, res, JSON.stringify(dummySourceMap), "json", {
              cacheControl: "no-cache",
              headers: server.config.server.headers,
            });
          }
        } else {
          const originalUrl = url.replace(/\.map($|\?)/, "$1");
          const map = (await moduleGraph.getModuleByUrl(originalUrl, false))
            ?.transformResult?.map;
          if (map) {
            return send(req, res, JSON.stringify(map), "json", {
              headers: server.config.server.headers,
            });
          } else {
            return next();
          }
        }
      }

      const publicDir = normalizePath(server.config.publicDir);
      const rootDir = normalizePath(server.config.root);
      if (publicDir.startsWith(rootDir)) {
        const publicPath = `${publicDir.slice(rootDir.length)}/`;
        if (url.startsWith(publicPath)) {
          let warning: string;

          if (isImportRequest(url)) {
            const rawUrl = removeImportQuery(url);

            warning =
              "Assets in public cannot be imported from JavaScript.\n" +
              `Instead of ${colors.cyan(
                rawUrl
              )}, put the file in the src directory, and use ${colors.cyan(
                rawUrl.replace(publicPath, "/src/")
              )} instead.`;
          } else {
            warning =
              `files in the public directory are served at the root path.\n` +
              `Instead of ${colors.cyan(url)}, use ${colors.cyan(
                url.replace(publicPath, "/")
              )}.`;
          }

          logger.warn(colors.yellow(warning));
        }
      }

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
          (await moduleGraph.getModuleByUrl(url, false))?.transformResult
            ?.etag === ifNoneMatch
        ) {
          debugCache?.(`[304] ${prettifyUrl(url, root)}`);
          res.statusCode = 304;
          return res.end();
        }

        const result = await transformRequest(url, server, {
          html: req.headers.accept?.includes("text/html"),
        });
        if (result) {
          const depsOptimizer = getDepsOptimizer(server.config, false);
          const type = isDirectCSSRequest(url) ? "css" : "js";
          const isDep =
            DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url);
          return send(req, res, result.code, type, {
            etag: result.etag,
            cacheControl: isDep ? "max-age=31536000,immutable" : "no-cache",
            headers: server.config.server.headers,
            map: result.map,
          });
        }
      }
    } catch (e) {
      console.log(e);
      if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
        if (!res.writableEnded) {
          res.statusCode = 504;
          res.statusMessage = "Optimize Deps Processing Error";
          res.end();
        }
        logger.error(e.message);
        return;
      }
      if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
        if (!res.writableEnded) {
          res.statusCode = 504;
          res.statusMessage = "Outdated Optimize Dep";
          res.end();
        }
        return;
      }
      if (e?.code === ERR_LOAD_URL) {
        return next();
      }
      return next(e);
    }

    next();
  };
}
