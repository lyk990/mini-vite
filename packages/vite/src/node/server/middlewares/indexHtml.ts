import { ViteDevServer } from "..";
import type { Connect } from "dep-types/connect";
import {
  cleanUrl,
  ensureWatchedFile,
  fsPathFromId,
  injectQuery,
  joinUrlSegments,
  normalizePath,
  processSrcSetSync,
  stripBase,
  unwrapId,
  wrapId,
} from "../../utils";
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from "../../constants";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { send } from "../send";
import {
  applyHtmlTransforms,
  htmlEnvHook,
  postImportMapHook,
  preImportMapHook,
  resolveHtmlTransforms,
  addToHTMLProxyCache,
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
import type { SourceMapInput } from "rollup";
import { ResolvedConfig } from "../../config";
import { checkPublicFile } from "../../plugins/asset";

interface AssetNode {
  start: number;
  end: number;
  code: string;
}

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
        preImportMapHook(server.config),
        ...preHooks,
        htmlEnvHook(server.config),
        devHtmlHook,
        ...normalHooks,
        ...postHooks,
        postImportMapHook(),
      ],
      {
        path: url,
        filename: getHtmlFilename(url, server),
        server,
        originalUrl,
      } as any // TODO need ssrTransform
    );
  };
}

const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl }
) => {
  const { config, moduleGraph, watcher } = server!;
  const base = config.base || "/";

  let proxyModulePath: string;
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
  let inlineModuleIndex = -1;
  const proxyCacheUrl = cleanUrl(proxyModulePath).replace(
    normalizePath(config.root),
    ""
  );
  const styleUrl: AssetNode[] = [];

  const addInlineModule = (
    node: DefaultTreeAdapterMap["element"],
    ext: "js"
  ) => {
    inlineModuleIndex++;

    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap["textNode"];

    const code = contentNode.value;

    let map: SourceMapInput | undefined;
    if (proxyModulePath[0] !== "\0") {
      map = new MagicString(html)
        .snip(
          contentNode.sourceCodeLocation!.startOffset,
          contentNode.sourceCodeLocation!.endOffset
        )
        .generateMap({ hires: true });
      map.sources = [filename];
      map.file = filename;
    }

    addToHTMLProxyCache(config as any, proxyCacheUrl, inlineModuleIndex, {
      code,
      map,
    });

    const modulePath = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`;

    // invalidate the module so the newly cached contents will be served
    const module = server?.moduleGraph.getModuleById(modulePath);
    if (module) {
      server?.moduleGraph.invalidateModule(module);
    }
    s.update(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${modulePath}"></script>`
    );
    preTransformRequest(server! as any, modulePath, base);
  };

  await traverseHtml(html, filename, (node) => {
    if (!nodeIsElement(node)) {
      return;
    }

    // script tags
    if (node.nodeName === "script") {
      const { src, sourceCodeLocation, isModule } = getScriptInfo(node);

      if (src) {
        processNodeUrl(
          src,
          sourceCodeLocation!,
          s,
          config as any,
          htmlPath,
          originalUrl,
          server as any
        );
      } else if (isModule && node.childNodes.length) {
        addInlineModule(node, "js");
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

    // elements with [href/src] attrs
    const assetAttrs = assetAttrsConfig[node.nodeName];
    if (assetAttrs) {
      for (const p of node.attrs) {
        const attrKey = getAttrKey(p);
        if (p.value && assetAttrs.includes(attrKey)) {
          processNodeUrl(
            p,
            node.sourceCodeLocation!.attrs![attrKey],
            s,
            config as any,
            htmlPath,
            originalUrl
          );
        }
      }
    }
  });

  await Promise.all(
    styleUrl.map(async ({ start, end, code }, index) => {
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`;

      // ensure module in graph after successful load
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

  // transform all url as non-ssr as html includes client-side assets only
  server.transformRequest(url).catch((e) => {
    // Unexpected error, log the issue but avoid an unhandled exception
    server.config.logger.error(e.message);
  });
}

const processNodeUrl = (
  attr: Token.Attribute,
  sourceCodeLocation: Token.Location,
  s: MagicString,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  server?: ViteDevServer
) => {
  let url = attr.value || "";

  if (server?.moduleGraph) {
    const mod = server.moduleGraph.urlToModuleMap.get(url);
    if (mod && mod.lastHMRTimestamp > 0) {
      url = injectQuery(url, `t=${mod.lastHMRTimestamp}`);
    }
  }
  const devBase = config.base;
  if (url[0] === "/" && url[1] !== "/") {
    // prefix with base (dev only, base is never relative)
    const fullUrl = path.posix.join(devBase, url);
    overwriteAttrValue(s, sourceCodeLocation, fullUrl);
    if (server && !checkPublicFile(url, config)) {
      preTransformRequest(server, fullUrl, devBase);
    }
  } else if (
    url[0] === "." &&
    originalUrl &&
    originalUrl !== "/" &&
    htmlPath === "/index.html"
  ) {
    // prefix with base (dev only, base is never relative)
    const replacer = (url: string) => {
      const fullUrl = path.posix.join(devBase, url);
      if (server && !checkPublicFile(url, config)) {
        preTransformRequest(server, fullUrl, devBase);
      }
      return fullUrl;
    };
    const processedUrl =
      attr.name === "srcset" && attr.prefix === undefined
        ? processSrcSetSync(url, ({ url }) => replacer(url))
        : replacer(url);
    overwriteAttrValue(s, sourceCodeLocation, processedUrl);
  }
};
