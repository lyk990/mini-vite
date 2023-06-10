import {
  HtmlTagDescriptor,
  IndexHtmlTransformContext,
  IndexHtmlTransformHook,
} from "vite";
import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { generateCodeFrame } from "../utils";
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

export const htmlProxyMap = new WeakMap<
  ResolvedConfig,
  Map<string, Array<{ code: string; map?: SourceMapInput }>>
>();
/**获取plugin处理index.html的hook，并对hooks进行排序 */
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
/**
 * 遍历并执行tranformRequest中的hooks
 * 得到@vite/client的路径和index.html的内容
 * 并将其注入到head和body中
 */
export async function applyHtmlTransforms(
  html: string,
  hooks: IndexHtmlTransformHook[],
  ctx: IndexHtmlTransformContext
): Promise<string> {
  for (const hook of hooks) {
    // 执行hook之后得到index.html的内容和 需要注入到index.html中的标签(tags)
    // tags中有需要注入的@vite/client
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
/**
 * const tags = [{ tag: 'script', attrs: { src: 'main.js' } ]
 * 将tags中的内容转换成html字符串
 * */
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
/**
 * const attrs= { id: 'my-element', class: 'my-class' }
 * 将attrs中的内容转换成html字符串
 */
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
/**给字符串增加缩进 */
function incrementIndent(indent: string = "") {
  return `${indent}${indent[0] === "\t" ? "\t" : "  "}`;
}
/**将ast转换成html字符串 */
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
/**指定的内容注入到head标签 */
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
/**指定的内容注入到body标签 */
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
/**如果没有head标签的话 */
function prependInjectFallback(html: string, tags: HtmlTagDescriptor[]) {
  if (htmlPrependInjectRE.test(html)) {
    return html.replace(htmlPrependInjectRE, `$&\n${serializeTags(tags)}`);
  }
  if (doctypePrependInjectRE.test(html)) {
    return html.replace(doctypePrependInjectRE, `$&\n${serializeTags(tags)}`);
  }
  return serializeTags(tags) + html;
}
/**将html文件转换成ast */
export async function traverseHtml(
  html: string,
  filePath: string,
  visitor: (node: DefaultTreeAdapterMap["node"]) => void
): Promise<void> {
  const { parse } = await import("parse5");
  const ast = parse(html, {
    scriptingEnabled: false,
    sourceCodeLocationInfo: true,
    onParseError: (e: ParserError) => {
      handleParseError(e, html, filePath);
    },
  });
  traverseNodes(ast, visitor);
}
/**捕获ast转换失败的错误，语法错误或无效的语法结构，就会抛出错误 */
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
/**对document根节点进行处理 */
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
/**将ast解析抛出的错误进行格式化处理，方便定位问题 */
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
/**获取script节点的相关信息 */
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
/** 将<link> 标签的 href 属性值替换为newValue */
export function overwriteAttrValue(
  s: MagicString,
  sourceCodeLocation: Token.Location,
  newValue: string
): MagicString {
  // 对link标签做切割, srcString ='href="/vite.svg"'
  //  newValue = "/vite.svg"
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

export const isHTMLProxy = (id: string): boolean => htmlProxyRE.test(id);

export const htmlProxyResult = new Map<string, string>();
