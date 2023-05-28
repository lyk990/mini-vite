import { ViteDevServer } from "../..";
import type { Connect } from "dep-types/connect";
import { Options } from "sirv"; // NOTE patchedDependencies
import sirv from "sirv";
import {
  cleanUrl,
  fsPathFromUrl,
  isImportRequest,
  isInternalRequest,
  isParentDirectory,
  removeLeadingSlash,
  shouldServeFile,
} from "../../utils";
import type { OutgoingHttpHeaders } from "node:http";
import path from "node:path";

const knownJavascriptExtensionRE = /\.[tj]sx?$/;

const sirvOptions = ({
  headers,
  shouldServe,
}: {
  headers?: OutgoingHttpHeaders;
  shouldServe?: (p: string) => void;
}): Options => {
  return {
    dev: true,
    etag: true,
    extensions: [],
    setHeaders(res, pathname) {
      if (knownJavascriptExtensionRE.test(pathname)) {
        res.setHeader("Content-Type", "application/javascript");
      }
      if (headers) {
        for (const name in headers) {
          res.setHeader(name, headers[name]!);
        }
      }
    },
    shouldServe,
  };
};

export function servePublicMiddleware(
  dir: string,
  headers?: OutgoingHttpHeaders
): Connect.NextHandleFunction {
  const serve = sirv(
    dir,
    sirvOptions({
      headers,
      shouldServe: (filePath) => shouldServeFile(filePath, dir),
    })
  );

  return function viteServePublicMiddleware(req, res, next) {
    if (isImportRequest(req.url!) || isInternalRequest(req.url!)) {
      return next();
    }
    serve(req, res, next);
  };
}

export function serveRawFsMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  return function viteServeRawFsMiddleware(req, res, next) {
    next();
  };
}

export function serveStaticMiddleware(
  dir: string,
  server: ViteDevServer
): Connect.NextHandleFunction {
  const serve = sirv(
    dir,
    sirvOptions({
      headers: server.config.server.headers,
    })
  );

  return function viteServeStaticMiddleware(req, res, next) {
    const cleanedUrl = cleanUrl(req.url!);
    if (
      cleanedUrl[cleanedUrl.length - 1] === "/" ||
      path.extname(cleanedUrl) === ".html" ||
      isInternalRequest(req.url!)
    ) {
      return next();
    }

    const url = new URL(req.url!, "http://example.com");
    const pathname = decodeURIComponent(url.pathname);

    let redirectedPathname: string | undefined;
    for (const { find, replacement } of server.config.resolve.alias) {
      const matches =
        typeof find === "string"
          ? pathname.startsWith(find)
          : find.test(pathname);
      if (matches) {
        redirectedPathname = pathname.replace(find, replacement);
        break;
      }
    }
    const resolvedPathname = redirectedPathname || pathname;
    let fileUrl = path.resolve(dir, removeLeadingSlash(resolvedPathname));
    if (
      resolvedPathname[resolvedPathname.length - 1] === "/" &&
      fileUrl[fileUrl.length - 1] !== "/"
    ) {
      fileUrl = fileUrl + "/";
    }
    serve(req, res, next);
  };
}

export function isFileServingAllowed(
  url: string,
  server: ViteDevServer
): boolean {
  if (!server.config.server.fs.strict) return true;

  const file = fsPathFromUrl(url);

  if (server.moduleGraph.safeModulesPath.has(file)) return true;

  if (server.config.server.fs.allow.some((dir) => isParentDirectory(dir, file)))
    return true;

  return false;
}
