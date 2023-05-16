import { ViteDevServer } from "../..";
import type { Connect } from "dep-types/connect";
import { Options } from "sirv"; // NOTE patchedDependencies
import sirv from "sirv";
import { FS_PREFIX } from "../../constants";
import {
  cleanUrl,
  fsPathFromId,
  fsPathFromUrl,
  isFileReadable,
  isImportRequest,
  isInternalRequest,
  isParentDirectory,
  isWindows,
  removeLeadingSlash,
  slash,
} from "../../utils";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import path from "node:path";
import escapeHtml from "escape-html";

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
  const serveFromRoot = sirv(
    "/",
    sirvOptions({ headers: server.config.server.headers })
  );

  return function viteServeRawFsMiddleware(req, res, next) {
    const url = new URL(req.url!, "http://example.com");
    if (url.pathname.startsWith(FS_PREFIX)) {
      const pathname = decodeURIComponent(url.pathname);
      if (
        !ensureServingAccess(
          slash(path.resolve(fsPathFromId(pathname))),
          server,
          res,
          next
        )
      ) {
        return;
      }

      let newPathname = pathname.slice(FS_PREFIX.length);
      if (isWindows) newPathname = newPathname.replace(/^[A-Z]:/i, "");

      url.pathname = encodeURIComponent(newPathname);
      req.url = url.href.slice(url.origin.length);
      serveFromRoot(req, res, next);
    } else {
      next();
    }
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
    if (redirectedPathname) {
      // dir is pre-normalized to posix style
      if (redirectedPathname.startsWith(dir)) {
        redirectedPathname = redirectedPathname.slice(dir.length);
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
    if (!ensureServingAccess(fileUrl, server, res, next)) {
      return;
    }

    if (redirectedPathname) {
      url.pathname = encodeURIComponent(redirectedPathname);
      req.url = url.href.slice(url.origin.length);
    }

    serve(req, res, next);
  };
}

function ensureServingAccess(
  url: string,
  server: ViteDevServer,
  res: ServerResponse,
  next: Connect.NextFunction
): boolean {
  if (isFileServingAllowed(url, server)) {
    return true;
  }
  if (isFileReadable(cleanUrl(url))) {
    const urlMessage = `The request url "${url}" is outside of Vite serving allow list.`;
    const hintMessage = `
${server.config.server.fs.allow.map((i) => `- ${i}`).join("\n")}

Refer to docs https://vitejs.dev/config/server-options.html#server-fs-allow for configurations and more details.`;

    server.config.logger.error(urlMessage);
    server.config.logger.warnOnce(hintMessage + "\n");
    res.statusCode = 403;
    res.write(renderRestrictedErrorHTML(urlMessage + "\n" + hintMessage));
    res.end();
  } else {
    next();
  }
  return false;
}

export function isFileServingAllowed(
  url: string,
  server: ViteDevServer
): boolean {
  if (!server.config.server.fs.strict) return true;

  const file = fsPathFromUrl(url);

  if (server._fsDenyGlob(file)) return false;

  if (server.moduleGraph.safeModulesPath.has(file)) return true;

  if (server.config.server.fs.allow.some((dir) => isParentDirectory(dir, file)))
    return true;

  return false;
}

function renderRestrictedErrorHTML(msg: string): string {
  // to have syntax highlighting and autocompletion in IDE
  const html = String.raw;
  return html`
    <body>
      <h1>403 Restricted</h1>
      <p>${escapeHtml(msg).replace(/\n/g, "<br/>")}</p>
      <style>
        body {
          padding: 1em 2em;
        }
      </style>
    </body>
  `;
}
