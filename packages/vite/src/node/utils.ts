import os from "os";
import path from "node:path";
import type { AddressInfo, Server } from "node:net";
import type { CommonServerOptions } from "vite";
import type { ResolvedConfig } from "./config";
import type { ResolvedServerUrls, ViteDevServer } from "./server";
import debug from "debug";
import type { FSWatcher } from "chokidar";
import fs from "node:fs";
import { FS_PREFIX, NULL_BYTE_PLACEHOLDER, VALID_ID_PREFIX } from "./constants";
// import colors from "picocolors";
import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { createFilter as _createFilter } from '@rollup/pluginutils'

export function slash(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isObject(value: unknown): value is Record<string, any> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

export const blankReplacer = (match: string): string =>
  " ".repeat(match.length);

const postfixRE = /[?#].*$/s;
export function cleanUrl(url: string): string {
  return url.replace(postfixRE, "");
}

export const isWindows = os.platform() === "win32";
/**处理操作系统的兼容性问题,将\\替换成/ */
export function normalizePath(id: string): string {
  return path.posix.normalize(isWindows ? slash(id) : id);
}
export async function resolveServerUrls(
  server: Server,
  options: CommonServerOptions,
  config: ResolvedConfig
): Promise<ResolvedServerUrls> {
  const address = server.address();

  const isAddressInfo = (x: any): x is AddressInfo => x?.address;
  if (!isAddressInfo(address)) {
    return { local: [], network: [] };
  }
  const protocol = options.https ? "https" : "http";
  const hostnameName = "localhost";
  const base = "/";
  const port = address.port;
  const local: string[] = [];
  const network: string[] = [];
  local.push(`${protocol}://${hostnameName}:${port}${base}`);
  network.push("ipv4地址");
  return { local, network };
}
export type ViteDebugScope = `vite:${string}`;
interface DebuggerOptions {
  onlyWhenFocused?: boolean | string;
}
export function createDebugger(
  namespace: ViteDebugScope,
  options: DebuggerOptions = {}
): debug.Debugger["log"] | undefined {
  const log = debug(namespace);
  const { onlyWhenFocused } = options;

  let enabled = log.enabled;
  if (enabled && onlyWhenFocused) {
    const ns =
      typeof onlyWhenFocused === "string" ? onlyWhenFocused : namespace;
    enabled = !!DEBUG?.includes(ns);
  }

  if (enabled) {
    return (msg: string, ...args: any[]) => {
      if (!filter || msg.includes(filter)) {
        log(msg, ...args);
      }
    };
  }
}

const filter = process.env.VITE_DEBUG_FILTER;
const DEBUG = process.env.DEBUG;
export const externalRE = /^(https?:)?\/\//;
export const dataUrlRE = /^\s*data:/i;
export const virtualModuleRE = /^virtual-module:.*/;
export const virtualModulePrefix = "virtual-module:";

export function ensureWatchedFile(
  watcher: FSWatcher,
  file: string | null,
  root: string
): void {
  if (
    file &&
    // only need to watch if out of root
    !file.startsWith(root + "/") &&
    // some rollup plugins use null bytes for private resolved Ids
    !file.includes("\0") &&
    fs.existsSync(file)
  ) {
    // resolve file to normalized system path
    watcher.add(path.resolve(file));
  }
}

export function arrayEqual(a: any[], b: any[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function diffDnsOrderChange(
  oldUrls: ViteDevServer["resolvedUrls"],
  newUrls: ViteDevServer["resolvedUrls"]
): boolean {
  return !(
    oldUrls === newUrls ||
    (oldUrls &&
      newUrls &&
      arrayEqual(oldUrls.local, newUrls.local) &&
      arrayEqual(oldUrls.network, newUrls.network))
  );
}
const VOLUME_RE = /^[A-Z]:/i;

export function isDefined<T>(value: T | undefined | null): value is T {
  return value != null;
}

export function fsPathFromId(id: string): string {
  const fsPath = normalizePath(
    id.startsWith(FS_PREFIX) ? id.slice(FS_PREFIX.length) : id
  );
  return fsPath[0] === "/" || fsPath.match(VOLUME_RE) ? fsPath : `/${fsPath}`;
}

export async function asyncFlatten<T>(arr: T[]): Promise<T[]> {
  do {
    arr = (await Promise.all(arr)).flat(Infinity) as any;
  } while (arr.some((v: any) => v?.then));
  return arr;
}

export function arraify<T>(target: T | T[]): T[] {
  return Array.isArray(target) ? target : [target];
}

export function joinUrlSegments(a: string, b: string): string {
  if (!a || !b) {
    return a || b || "";
  }
  if (a[a.length - 1] === "/") {
    a = a.substring(0, a.length - 1);
  }
  if (b[0] !== "/") {
    b = "/" + b;
  }
  return a + b;
}

export function wrapId(id: string): string {
  return id.startsWith(VALID_ID_PREFIX)
    ? id
    : VALID_ID_PREFIX + id.replace("\0", NULL_BYTE_PLACEHOLDER);
}

export function unwrapId(id: string): string {
  return id.startsWith(VALID_ID_PREFIX)
    ? id.slice(VALID_ID_PREFIX.length).replace(NULL_BYTE_PLACEHOLDER, "\0")
    : id;
}

export function stripBase(path: string, base: string): string {
  if (path === base) {
    return "/";
  }
  const devBase = base[base.length - 1] === "/" ? base : base + "/";
  return path.startsWith(devBase) ? path.slice(devBase.length - 1) : path;
}

const splitRE = /\r?\n/;
const range: number = 2;

export function posToNumber(
  source: string,
  pos: number | { line: number; column: number }
): number {
  if (typeof pos === "number") return pos;
  const lines = source.split(splitRE);
  const { line, column } = pos;
  let start = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    start += lines[i].length + 1;
  }
  return start + column;
}

export function generateCodeFrame(
  source: string,
  start: number | { line: number; column: number } = 0,
  end?: number
): string {
  start = posToNumber(source, start);
  end = end || start;
  const lines = source.split(splitRE);
  let count = 0;
  const res: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    count += lines[i].length + 1;
    if (count >= start) {
      for (let j = i - range; j <= i + range || end > count; j++) {
        if (j < 0 || j >= lines.length) continue;
        const line = j + 1;
        res.push(
          `${line}${" ".repeat(Math.max(3 - String(line).length, 0))}|  ${
            lines[j]
          }`
        );
        const lineLength = lines[j].length;
        if (j === i) {
          // push underline
          const pad = Math.max(start - (count - lineLength) + 1, 0);
          const length = Math.max(
            1,
            end > count ? lineLength - pad : end - start
          );
          res.push(`   |  ` + " ".repeat(pad) + "^".repeat(length));
        } else if (j > i) {
          if (end > count) {
            const length = Math.max(Math.min(end - count, lineLength), 1);
            res.push(`   |  ` + "^".repeat(length));
          }
          count += lineLength + 1;
        }
      }
      break;
    }
  }
  return res.join("\n");
}

const replacePercentageRE = /%/g;
export function injectQuery(url: string, queryToInject: string): string {
  // encode percents for consistent behavior with pathToFileURL
  // see #2614 for details
  const resolvedUrl = new URL(
    url.replace(replacePercentageRE, "%25"),
    "relative:///"
  );
  const { search, hash } = resolvedUrl;
  let pathname = cleanUrl(url);
  pathname = isWindows ? slash(pathname) : pathname;
  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ""}${
    hash ?? ""
  }`;
}

interface ImageCandidate {
  url: string;
  descriptor: string;
}
function reduceSrcset(ret: { url: string; descriptor: string }[]) {
  return ret.reduce((prev, { url, descriptor }, index) => {
    descriptor ??= "";
    return (prev +=
      url + ` ${descriptor}${index === ret.length - 1 ? "" : ", "}`);
  }, "");
}

const cleanSrcSetRE =
  /(?:url|image|gradient|cross-fade)\([^)]*\)|"([^"]|(?<=\\)")*"|'([^']|(?<=\\)')*'/g;

function splitSrcSet(srcs: string) {
  const parts: string[] = [];
  // There could be a ',' inside of url(data:...), linear-gradient(...) or "data:..."
  const cleanedSrcs = srcs.replace(cleanSrcSetRE, blankReplacer);
  let startIndex = 0;
  let splitIndex: number;
  do {
    splitIndex = cleanedSrcs.indexOf(",", startIndex);
    parts.push(
      srcs.slice(startIndex, splitIndex !== -1 ? splitIndex : undefined)
    );
    startIndex = splitIndex + 1;
  } while (splitIndex !== -1);
  return parts;
}
const escapedSpaceCharacters = /( |\\t|\\n|\\f|\\r)+/g;
const imageSetUrlRE = /^(?:[\w\-]+\(.*?\)|'.*?'|".*?"|\S*)/;

function splitSrcSetDescriptor(srcs: string): ImageCandidate[] {
  return splitSrcSet(srcs)
    .map((s) => {
      const src = s.replace(escapedSpaceCharacters, " ").trim();
      const [url] = imageSetUrlRE.exec(src) || [""];

      return {
        url,
        descriptor: src?.slice(url.length).trim(),
      };
    })
    .filter(({ url }) => !!url);
}

export function processSrcSetSync(
  srcs: string,
  replacer: (arg: ImageCandidate) => string
): string {
  return reduceSrcset(
    splitSrcSetDescriptor(srcs).map(({ url, descriptor }) => ({
      url: replacer({ url, descriptor }),
      descriptor,
    }))
  );
}

const knownJsSrcRE = /\.(?:[jt]sx?|m[jt]s|vue|marko|svelte|astro|imba)(?:$|\?)/;
export const isJSRequest = (url: string): boolean => {
  url = cleanUrl(url);
  if (knownJsSrcRE.test(url)) {
    return true;
  }
  if (!path.extname(url) && url[url.length - 1] !== "/") {
    return true;
  }
  return false;
};

export function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function isInNodeModules(id: string): boolean {
  return id.includes("node_modules");
}

// export function prettifyUrl(url: string, root: string): string {
//   url = removeTimestampQuery(url);
//   const isAbsoluteFile = url.startsWith(root);
//   if (isAbsoluteFile || url.startsWith(FS_PREFIX)) {
//     const file = path.relative(root, isAbsoluteFile ? url : fsPathFromId(url));
//     return colors.dim(file);
//   } else {
//     return colors.dim(url);
//   }
// }
// const timestampRE = /\bt=\d{13}&?\b/;
// const trailingSeparatorRE = /[?&]$/;
// export function removeTimestampQuery(url: string): string {
//   return url.replace(timestampRE, "").replace(trailingSeparatorRE, "");
// }

// export function stripBomTag(content: string): string {
//   if (content.charCodeAt(0) === 0xfeff) {
//     return content.slice(1);
//   }

//   return content;
// }

export function getShortName(file: string, root: string) {
  return file.startsWith(root + "/") ? path.posix.relative(root, file) : file;
}
/**查找package.json文件 */
export function lookupFile(
  dir: string,
  fileNames: string[]
): string | undefined {
  while (dir) {
    // fileNames=['package.json']
    for (const fileName of fileNames) {
      const fullPath = path.join(dir, fileName);
      if (tryStatSync(fullPath)?.isFile()) return fullPath;
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) return;

    dir = parentDir;
  }
}
/**获取文件信息 */
export function tryStatSync(file: string): fs.Stats | undefined {
  try {
    // fs.statSync 获取文件信息 throwIfNoEntry <boolean> 如果文件系统条目不存在，
    // 是否会抛出异常。 默认值: true。
    return fs.statSync(file, { throwIfNoEntry: false });
  } catch {
    // Ignore errors
  }
}
const builtins = new Set([
  ...builtinModules,
  "assert/strict",
  "diagnostics_channel",
  "dns/promises",
  "fs/promises",
  "path/posix",
  "path/win32",
  "readline/promises",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "timers/promises",
  "util/types",
  "wasi",
]);
const NODE_BUILTIN_NAMESPACE = "node:";
export function isBuiltin(id: string): boolean {
  return builtins.has(
    id.startsWith(NODE_BUILTIN_NAMESPACE)
      ? id.slice(NODE_BUILTIN_NAMESPACE.length)
      : id
  );
}

export function getHash(text: Buffer | string): string {
  return createHash("sha256").update(text).digest("hex").substring(0, 8);
}

const replaceSlashOrColonRE = /[/:]/g;
const replaceDotRE = /\./g;
const replaceNestedIdRE = /(\s*>\s*)/g;
const replaceHashRE = /#/g;
export const flattenId = (id: string): string =>
  id
    .replace(replaceSlashOrColonRE, "_")
    .replace(replaceDotRE, "__")
    .replace(replaceNestedIdRE, "___")
    .replace(replaceHashRE, "____");

export type FilterPattern =
  | ReadonlyArray<string | RegExp>
  | string
  | RegExp
  | null;
export const createFilter = _createFilter as (
  include?: FilterPattern,
  exclude?: FilterPattern,
  options?: { resolve?: string | false | null }
) => (id: string | unknown) => boolean;
