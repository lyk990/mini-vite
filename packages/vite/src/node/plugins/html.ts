import {
  HtmlTagDescriptor,
  IndexHtmlTransformContext,
  IndexHtmlTransformHook,
} from "vite";
import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { cleanUrl, generateCodeFrame, normalizePath } from "../utils";
// import path from "node:path";
// import colors from "picocolors";
// import { resolveEnvPrefix } from "../env";
import { RollupError, SourceMapInput } from "rollup";
import { DefaultTreeAdapterMap, ParserError, Token } from "parse5";
import MagicString from "magic-string";

const headInjectRE = /([ \t]*)<\/head>/i;
const headPrependInjectRE = /([ \t]*)<head[^>]*>/i;

const htmlInjectRE = /<\/html>/i;
const htmlPrependInjectRE = /([ \t]*)<html[^>]*>/i;

const bodyInjectRE = /([ \t]*)<\/body>/i;
const bodyPrependInjectRE = /([ \t]*)<body[^>]*>/i;

const doctypePrependInjectRE = /<!doctype html>/i;

const unaryTags = new Set(["link", "meta", "base"]);

const htmlProxyRE = /\?html-proxy=?(?:&inline-css)?&index=(\d+)\.(js|css)$/;

// const importMapRE =
//   /[ \t]*<script[^>]*type\s*=\s*(?:"importmap"|'importmap'|importmap)[^>]*>.*?<\/script>/is;
// const moduleScriptRE =
//   /[ \t]*<script[^>]*type\s*=\s*(?:"module"|'module'|module)[^>]*>/i;
// const modulePreloadLinkRE =
  // /[ \t]*<link[^>]*rel\s*=\s*(?:"modulepreload"|'modulepreload'|modulepreload)[\s\S]*?\/>/i;
// const importMapAppendRE = new RegExp(
//   [moduleScriptRE, modulePreloadLinkRE].map((r) => r.source).join("|"),
//   "i"
// );

export const htmlProxyMap = new WeakMap<
  ResolvedConfig,
  Map<string, Array<{ code: string; map?: SourceMapInput }>>
>();

export function resolveHtmlTransforms(
  plugins: readonly Plugin[]
): [
  IndexHtmlTransformHook[],
  IndexHtmlTransformHook[],
  IndexHtmlTransformHook[]
] {
  const preHooks: IndexHtmlTransformHook[] = [];
  const normalHooks: IndexHtmlTransformHook[] = [];
  const postHooks: IndexHtmlTransformHook[] = [];

  for (const plugin of plugins) {
    const hook = plugin.transformIndexHtml;
    if (!hook) continue;

    if (typeof hook === "function") {
      normalHooks.push(hook);
    } else {
      const order = hook.order ?? (hook.enforce === "pre" ? "pre" : undefined);
      // @ts-expect-error union type
      const handler = hook.handler ?? hook.transform;
      if (order === "pre") {
        preHooks.push(handler);
      } else if (order === "post") {
        postHooks.push(handler);
      } else {
        normalHooks.push(handler);
      }
    }
  }

  return [preHooks, normalHooks, postHooks];
}
/**遍历hooks */
export async function applyHtmlTransforms(
  html: string,
  hooks: IndexHtmlTransformHook[],
  ctx: IndexHtmlTransformContext
): Promise<string> {
  for (const hook of hooks) {
    const res = await hook(html, ctx);
    if (!res) {
      continue;
    }
    if (typeof res === "string") {
      html = res;
    } else {
      let tags: HtmlTagDescriptor[];
      if (Array.isArray(res)) {
        tags = res;
      } else {
        html = res.html || html;
        tags = res.tags;
      }

      const headTags: HtmlTagDescriptor[] = [];
      const headPrependTags: HtmlTagDescriptor[] = [];
      const bodyTags: HtmlTagDescriptor[] = [];
      const bodyPrependTags: HtmlTagDescriptor[] = [];

      for (const tag of tags) {
        if (tag.injectTo === "body") {
          bodyTags.push(tag);
        } else if (tag.injectTo === "body-prepend") {
          bodyPrependTags.push(tag);
        } else if (tag.injectTo === "head") {
          headTags.push(tag);
        } else {
          headPrependTags.push(tag);
        }
      }

      html = injectToHead(html, headPrependTags, true);
      html = injectToHead(html, headTags);
      html = injectToBody(html, bodyPrependTags, true);
      html = injectToBody(html, bodyTags);
    }
  }

  return html;
}
/**序列化标签 */
function serializeTags(
  tags: HtmlTagDescriptor["children"],
  indent: string = ""
): string {
  if (typeof tags === "string") {
    return tags;
  } else if (tags && tags.length) {
    return tags
      .map((tag) => `${indent}${serializeTag(tag, indent)}\n`)
      .join("");
  }
  return "";
}

function serializeAttrs(attrs: HtmlTagDescriptor["attrs"]): string {
  let res = "";
  for (const key in attrs) {
    if (typeof attrs[key] === "boolean") {
      res += attrs[key] ? ` ${key}` : ``;
    } else {
      res += ` ${key}=${JSON.stringify(attrs[key])}`;
    }
  }
  return res;
}

function incrementIndent(indent: string = "") {
  return `${indent}${indent[0] === "\t" ? "\t" : "  "}`;
}

function serializeTag(
  { tag, attrs, children }: HtmlTagDescriptor,
  indent: string = ""
): string {
  if (unaryTags.has(tag)) {
    return `<${tag}${serializeAttrs(attrs)}>`;
  } else {
    return `<${tag}${serializeAttrs(attrs)}>${serializeTags(
      children,
      incrementIndent(indent)
    )}</${tag}>`;
  }
}
/**注入并替换 */
function injectToHead(
  html: string,
  tags: HtmlTagDescriptor[],
  prepend = false
) {
  if (tags.length === 0) return html;

  if (prepend) {
    if (headPrependInjectRE.test(html)) {
      return html.replace(
        headPrependInjectRE,
        (match, p1) => `${match}\n${serializeTags(tags, incrementIndent(p1))}`
      );
    }
  } else {
    if (headInjectRE.test(html)) {
      return html.replace(
        headInjectRE,
        (match, p1) => `${serializeTags(tags, incrementIndent(p1))}${match}`
      );
    }
    if (bodyPrependInjectRE.test(html)) {
      return html.replace(
        bodyPrependInjectRE,
        (match, p1) => `${serializeTags(tags, p1)}\n${match}`
      );
    }
  }
  return prependInjectFallback(html, tags);
}

function injectToBody(
  html: string,
  tags: HtmlTagDescriptor[],
  prepend = false
) {
  if (tags.length === 0) return html;

  if (prepend) {
    if (bodyPrependInjectRE.test(html)) {
      return html.replace(
        bodyPrependInjectRE,
        (match, p1) => `${match}\n${serializeTags(tags, incrementIndent(p1))}`
      );
    }
    if (headInjectRE.test(html)) {
      return html.replace(
        headInjectRE,
        (match, p1) => `${match}\n${serializeTags(tags, p1)}`
      );
    }
    return prependInjectFallback(html, tags);
  } else {
    if (bodyInjectRE.test(html)) {
      return html.replace(
        bodyInjectRE,
        (match, p1) => `${serializeTags(tags, incrementIndent(p1))}${match}`
      );
    }
    if (htmlInjectRE.test(html)) {
      return html.replace(htmlInjectRE, `${serializeTags(tags)}\n$&`);
    }
    return html + `\n` + serializeTags(tags);
  }
}

function prependInjectFallback(html: string, tags: HtmlTagDescriptor[]) {
  if (htmlPrependInjectRE.test(html)) {
    return html.replace(htmlPrependInjectRE, `$&\n${serializeTags(tags)}`);
  }
  if (doctypePrependInjectRE.test(html)) {
    return html.replace(doctypePrependInjectRE, `$&\n${serializeTags(tags)}`);
  }
  return serializeTags(tags) + html;
}

// export function preImportMapHook(
//   config: ResolvedConfig
// ): IndexHtmlTransformHook {
//   return (html, ctx) => {
//     const importMapIndex = html.match(importMapRE)?.index;
//     if (importMapIndex === undefined) return;

//     const importMapAppendIndex = html.match(importMapAppendRE)?.index;
//     if (importMapAppendIndex === undefined) return;

//     if (importMapAppendIndex < importMapIndex) {
//       const relativeHtml = normalizePath(
//         path.relative(config.root, ctx.filename)
//       );
//       config.logger.warnOnce(
//         colors.yellow(
//           colors.bold(
//             `(!) <script type="importmap"> should come before <script type="module"> and <link rel="modulepreload"> in /${relativeHtml}`
//           )
//         )
//       );
//     }
//   };
// }

// export function htmlEnvHook(config: ResolvedConfig): IndexHtmlTransformHook {
//   const pattern = /%(\S+?)%/g;
//   // const envPrefix = resolveEnvPrefix({ envPrefix: config.envPrefix });
//   const env: Record<string, any> = { ...config.env };

//   for (const key in config.define) {
//     if (key.startsWith(`import.meta.env.`)) {
//       const val = config.define[key];
//       env[key.slice(16)] = typeof val === "string" ? val : JSON.stringify(val);
//     }
//   }
//   return (html, ctx) => {
//     return html.replace(pattern, (text, key) => {
//       if (key in env) {
//         return env[key];
//       } else {
//         // if (envPrefix.some((prefix) => key.startsWith(prefix))) {
//         //   const relativeHtml = normalizePath(
//         //     path.relative(config.root, ctx.filename)
//         //   );
//         //   config.logger.warn(
//         //     colors.yellow(
//         //       colors.bold(
//         //         `(!) ${text} is not defined in env variables found in /${relativeHtml}. ` +
//         //           `Is the variable mistyped?`
//         //       )
//         //     )
//         //   );
//         // }

//         return text;
//       }
//     });
//   };
// }

// export function postImportMapHook(): IndexHtmlTransformHook {
//   return (html) => {
//     if (!importMapAppendRE.test(html)) return;

//     let importMap: string | undefined;
//     html = html.replace(importMapRE, (match) => {
//       importMap = match;
//       return "";
//     });

//     if (importMap) {
//       html = html.replace(
//         importMapAppendRE,
//         (match) => `${importMap}\n${match}`
//       );
//     }

//     return html;
//   };
// }

// export function addToHTMLProxyCache(
//   config: ResolvedConfig,
//   filePath: string,
//   index: number,
//   result: { code: string; map?: SourceMapInput }
// ): void {
//   if (!htmlProxyMap.get(config)) {
//     htmlProxyMap.set(config, new Map());
//   }
//   if (!htmlProxyMap.get(config)!.get(filePath)) {
//     htmlProxyMap.get(config)!.set(filePath, []);
//   }
//   htmlProxyMap.get(config)!.get(filePath)![index] = result;
// }

export async function traverseHtml(
  html: string,
  filePath: string,
  visitor: (node: DefaultTreeAdapterMap["node"]) => void
): Promise<void> {
  const { parse } = await import("parse5");
  const ast = parse(html, {
    scriptingEnabled: false, // parse inside <noscript>
    sourceCodeLocationInfo: true,
    onParseError: (e: ParserError) => {
      handleParseError(e, html, filePath);
    },
  });
  traverseNodes(ast, visitor);
}

function handleParseError(
  parserError: ParserError,
  html: string,
  filePath: string
) {
  switch (parserError.code) {
    case "missing-doctype":
      return;
    case "abandoned-head-element-child":
      return;
    case "duplicate-attribute":
      return;
    case "non-void-html-element-start-tag-with-trailing-solidus":
      return;
  }
  const parseError = formatParseError(parserError, filePath, html);
  throw new Error(
    `Unable to parse HTML; ${parseError.message}\n` +
      // @ts-ignore
      ` at ${parseError.loc.file}:${parseError.loc.line}:${parseError.loc.column}\n` +
      `${parseError.frame}`
  );
}

function traverseNodes(
  node: DefaultTreeAdapterMap["node"],
  visitor: (node: DefaultTreeAdapterMap["node"]) => void
) {
  visitor(node);
  if (
    nodeIsElement(node) ||
    node.nodeName === "#document" ||
    node.nodeName === "#document-fragment"
  ) {
    node.childNodes.forEach((childNode) => traverseNodes(childNode, visitor));
  }
}

function formatParseError(parserError: ParserError, id: string, html: string) {
  const formattedError = {
    code: parserError.code,
    message: `parse5 error code ${parserError.code}`,
    frame: generateCodeFrame(html, parserError.startOffset),
    loc: {
      file: id,
      line: parserError.startLine,
      column: parserError.startCol,
    },
  } as RollupError;
  return formattedError;
}

export function nodeIsElement(
  node: DefaultTreeAdapterMap["node"]
): node is DefaultTreeAdapterMap["element"] {
  return node.nodeName[0] !== "#";
}

export function getScriptInfo(node: DefaultTreeAdapterMap["element"]): {
  src: Token.Attribute | undefined;
  sourceCodeLocation: Token.Location | undefined;
  isModule: boolean;
  isAsync: boolean;
} {
  let src: Token.Attribute | undefined;
  let sourceCodeLocation: Token.Location | undefined;
  let isModule = false;
  let isAsync = false;
  for (const p of node.attrs) {
    if (p.prefix !== undefined) continue;
    if (p.name === "src") {
      if (!src) {
        src = p;
        sourceCodeLocation = node.sourceCodeLocation?.attrs!["src"];
      }
    } else if (p.name === "type" && p.value && p.value === "module") {
      isModule = true;
    } else if (p.name === "async") {
      isAsync = true;
    }
  }
  return { src, sourceCodeLocation, isModule, isAsync };
}

const attrValueStartRE = /=\s*(.)/;
export function overwriteAttrValue(
  s: MagicString,
  sourceCodeLocation: Token.Location,
  newValue: string
): MagicString {
  const srcString = s.slice(
    sourceCodeLocation.startOffset,
    sourceCodeLocation.endOffset
  );
  const valueStart = srcString.match(attrValueStartRE);
  if (!valueStart) {
    throw new Error(
      `[vite:html] internal error, failed to overwrite attribute value`
    );
  }
  const wrapOffset = valueStart[1] === '"' || valueStart[1] === "'" ? 1 : 0;
  const valueOffset = valueStart.index! + valueStart[0].length - 1;
  s.update(
    sourceCodeLocation.startOffset + valueOffset + wrapOffset,
    sourceCodeLocation.endOffset - wrapOffset,
    newValue
  );
  return s;
}

export const assetAttrsConfig: Record<string, string[]> = {
  link: ["href"],
  video: ["src", "poster"],
  source: ["src", "srcset"],
  img: ["src", "srcset"],
  image: ["xlink:href", "href"],
  use: ["xlink:href", "href"],
};

export function getAttrKey(attr: Token.Attribute): string {
  return attr.prefix === undefined ? attr.name : `${attr.prefix}:${attr.name}`;
}

export function htmlInlineProxyPlugin(config: ResolvedConfig): Plugin {
  htmlProxyMap.set(config, new Map());
  return {
    name: "vite:html-inline-proxy",

    resolveId(id) {
      if (htmlProxyRE.test(id)) {
        return id;
      }
    },

    load(id) {
      const proxyMatch = id.match(htmlProxyRE);
      if (proxyMatch) {
        const index = Number(proxyMatch[1]);
        const file = cleanUrl(id);
        const url = file.replace(normalizePath(config.root), "");
        const result = htmlProxyMap.get(config)!.get(url)![index];
        if (result) {
          return result;
        } else {
          throw new Error(`No matching HTML proxy module found from ${id}`);
        }
      }
    },
  };
}

export const isHTMLProxy = (id: string): boolean => htmlProxyRE.test(id);

export const htmlProxyResult = new Map<string, string>();
export function addToHTMLProxyTransformResult(
  hash: string,
  code: string
): void {
  htmlProxyResult.set(hash, code);
}
