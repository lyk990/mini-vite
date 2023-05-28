import { ViteDevServer } from "..";
import type { Connect } from "dep-types/connect";
import {
  cleanUrl,
  ensureWatchedFile,
  joinUrlSegments,
  normalizePath,
  stripBase,
  unwrapId,
  wrapId,
} from "../../utils";
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
import type { DefaultTreeAdapterMap, Token } from "parse5";
import { ResolvedConfig } from "../../config";

interface AssetNode {
  start: number;
  end: number;
  code: string;
}

export function indexHtmlMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      return next();
    }

    const url = req.url && cleanUrl(req.url);

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
  return decodeURIComponent(
    normalizePath(path.join(server.config.root, url.slice(1)))
  );
}
/**改造index.html */
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
        devHtmlHook, // 主要调用这个钩子
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

const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server }
) => {
  const { config, moduleGraph, watcher } = server!;
  const base = config.base || "/";

  let proxyModulePath: string;
  // @ts-ignore
  let proxyModuleUrl: string;

  const trailingSlash = htmlPath.endsWith("/");
  if (!trailingSlash && fs.existsSync(filename)) {
    proxyModulePath = htmlPath;
    proxyModuleUrl = joinUrlSegments(base, htmlPath);
  } else {
    const validPath = `${htmlPath}${trailingSlash ? "index.html" : ""}`;
    proxyModulePath = `\0${validPath}`;
    proxyModuleUrl = wrapId(proxyModulePath);
  }

  const s = new MagicString(html);
  const styleUrl: AssetNode[] = [];

  await traverseHtml(html, filename, (node) => {
    if (!nodeIsElement(node)) {
      return;
    }

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

    if (node.nodeName === "style" && node.childNodes.length) {
      const children = node.childNodes[0] as DefaultTreeAdapterMap["textNode"];
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value,
      });
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

  await Promise.all(
    styleUrl.map(async ({ start, end, code }, index) => {
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`;

      const mod = await moduleGraph.ensureEntryFromUrl(url, false);
      ensureWatchedFile(watcher, mod.file, config.root);

      const result = await server!.pluginContainer.transform(code, mod.id!);
      s.overwrite(start, end, result?.code || "");
    })
  );

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

function preTransformRequest(server: ViteDevServer, url: string, base: string) {
  if (!server.config.server.preTransformRequests) return;

  url = unwrapId(stripBase(url, base));

  server.transformRequest(url).catch((e) => {
    server.config.logger.error(e.message);
  });
}

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
