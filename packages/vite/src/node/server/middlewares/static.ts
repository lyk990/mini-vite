import { ViteDevServer } from "../..";
import type { Connect } from "dep-types/connect";
import { Options } from "sirv"; // NOTE patchedDependencies
import sirv from "sirv"; // NOTE vite中的核心插件，用于处理静态资源
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
/**对public静态资源进行处理 */
export function servePublicMiddleware(
  dir: string,
  headers?: OutgoingHttpHeaders
): Connect.NextHandleFunction {
  // 不需要为sirv或指定默认端口，开发服务器会自动选择vite本地服务器端口。
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

/**静态资源中间件 */
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
    // 在 URL 中，某些字符是需要进行编码的，例如空格会被编码为 %20，
    // 需要将这些编码后的 URI 组件解码为原始的字符串形式，
    // 这时就可以使用 decodeURIComponent 函数
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
/**是否有权限去处理文件 */
export function isFileServingAllowed(
  url: string,
  server: ViteDevServer
): boolean {
  if (!server.config.server.fs.strict) return true;

  const file = fsPathFromUrl(url);
  // 当前文件url的绝对路径有没有被加进safeModulesPath中
  if (server.moduleGraph.safeModulesPath.has(file)) return true;

  if (server.config.server.fs.allow.some((dir) => isParentDirectory(dir, file)))
    return true;

  return false;
}
