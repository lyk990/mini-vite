import { ViteDevServer } from "..";
import type { Connect } from "dep-types/connect";
import { cleanUrl, normalizePath, stripBase, unwrapId } from "../../utils";
import { CLIENT_PUBLIC_PATH } from "../../constants";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { send } from "../send";
import {
  applyHtmlTransforms,
  resolveHtmlTransforms,
  traverseHtml,
  nodeIsElement,
  getScriptInfo,
  overwriteAttrValue,
  assetAttrsConfig,
  getAttrKey,
} from "../../plugins/html";
import { IndexHtmlTransformHook } from "vite";
import MagicString from "magic-string";
import type { Token } from "parse5";
import { ResolvedConfig } from "../../config";

/**index.html中间件，改造index.html,用来注入脚本，处理预加载资源等 */
export function indexHtmlMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      return next();
    }

    const url = req.url && cleanUrl(req.url);
    // 判断是否是index.html文件
    if (url?.endsWith(".html") && req.headers["sec-fetch-dest"] !== "script") {
      const filename = getHtmlFilename(url, server);
      if (fs.existsSync(filename)) {
        try {
          let html = await fsp.readFile(filename, "utf-8");
          // 得到注入脚本之后的html文件
          html = await server.transformIndexHtml(url, html, req.originalUrl);
          // req: http请求
          // res: http响应
          // html: 要发送的内容
          // "html": 指定响应的类型
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

/**去掉'/',得到文件名 */
function getHtmlFilename(url: string, server: ViteDevServer) {
  // decodeURIComponent处理URI组件的编码字符
  return decodeURIComponent(
    normalizePath(path.join(server.config.root, url.slice(1)))
  );
}

/**改造index.html,注入脚本 */
export function createDevHtmlTransformFn(
  server: ViteDevServer
): (url: string, html: string, originalUrl: string) => Promise<string> {
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    server.config.plugins
  );
  return (url: string, html: string, originalUrl: string): Promise<string> => {
    return applyHtmlTransforms(
      html,
      [
        ...preHooks,
        devHtmlHook, // 主要调用这个钩子,将client脚本注入到script标签中
        ...normalHooks,
        ...postHooks,
      ],
      {
        path: url,
        filename: getHtmlFilename(url, server),
        server,
        originalUrl,
      } as any
    );
  };
}

/**拦截index.html，注入脚本 */
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server }
) => {
  const { config } = server!;
  const base = config.base || "/";
  // @ts-ignore
  let proxyModulePath: string;
  // htmlPath = '/index.html'
  const trailingSlash = htmlPath.endsWith("/");
  // 当htmlpath不以/结尾，且文件路径存在时
  if (!trailingSlash && fs.existsSync(filename)) {
    proxyModulePath = htmlPath;
  } else {
    // 以\0开头的路径表示虚拟路径或特殊路径
    const validPath = `${htmlPath}${trailingSlash ? "index.html" : ""}`;
    proxyModulePath = `\0${validPath}`;
  }

  const s = new MagicString(html);
  // html: HTML内容
  // filename: html文件的路径
  // node: node节点
  await traverseHtml(html, filename, (node) => {
    // 不是node节点就直接返回
    if (!nodeIsElement(node)) {
      return;
    }
    // 当前节点是script标签时
    if (node.nodeName === "script") {
      const { src, sourceCodeLocation } = getScriptInfo(node);

      if (src) {
        processNodeUrl(
          src,
          sourceCodeLocation!,
          s,
          config as any,
          server as any
        );
      }
    }

    const assetAttrs = assetAttrsConfig[node.nodeName];
    if (assetAttrs) {
      for (const p of node.attrs) {
        const attrKey = getAttrKey(p);
        if (p.value && assetAttrs.includes(attrKey)) {
          processNodeUrl(
            p,
            node.sourceCodeLocation!.attrs![attrKey],
            s,
            config as any
          );
        }
      }
    }
  });

  html = s.toString();

  return {
    html,
    tags: [
      {
        tag: "script",
        attrs: {
          type: "module",
          // path.join 即会按照当前操作系统进行给定路径分隔符，
          // 而 path.posix.join 则始终是 /
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: "head-prepend",
      },
    ],
  };
};
/**
 * 调用transformRequest方法，对请求进行预处理
 *  包括路径重写、资源注入、请求过滤
 * */
function preTransformRequest(server: ViteDevServer, url: string, base: string) {
  if (!server.config.server.preTransformRequests) return;
  url = unwrapId(stripBase(url, base));
  server.transformRequest(url).catch((e) => {
    server.config.logger.error(e.message);
  });
}
/**对node路径进行重写 */
const processNodeUrl = (
  attr: Token.Attribute,
  sourceCodeLocation: Token.Location,
  s: MagicString,
  config: ResolvedConfig,
  server?: ViteDevServer
) => {
  let url = attr.value || "";

  const devBase = config.base;
  if (url[0] === "/" && url[1] !== "/") {
    const fullUrl = path.posix.join(devBase, url);
    overwriteAttrValue(s, sourceCodeLocation, fullUrl);
    if (server) {
      preTransformRequest(server, fullUrl, devBase);
    }
  }
};
