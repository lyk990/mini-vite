import os from "os";
import path from "node:path";
import type { AddressInfo, Server } from "node:net";
import type { CommonServerOptions, DepOptimizationConfig } from "vite";
import type { ResolvedConfig } from "./config";
import type { ResolvedServerUrls, ViteDevServer } from "./server";
import debug from "debug";
import type { FSWatcher } from "chokidar";
import fs from "node:fs";
import {
  CLIENT_ENTRY,
  CLIENT_PUBLIC_PATH,
  ENV_PUBLIC_PATH,
  FS_PREFIX,
  loopbackHosts,
  NULL_BYTE_PLACEHOLDER,
  OPTIMIZABLE_ENTRY_RE,
  VALID_ID_PREFIX,
  wildcardHosts,
} from "./constants";
import colors from "picocolors";
import { builtinModules, createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createFilter as _createFilter } from "@rollup/pluginutils";
import { exec } from "node:child_process";
import { TransformResult } from "rollup";
import type MagicString from "magic-string";
import { resolvePackageData } from "./packages";
import { fileURLToPath } from "node:url";
import { promises as dns } from "node:dns";
import type { Alias, AliasOptions } from "dep-types/alias";

export function slash(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isObject(value: unknown): value is Record<string, any> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

export const blankReplacer = (match: string): string =>
  " ".repeat(match.length);

const postfixRE = /[?#].*$/s;
/**将？#转换成'' */
export function cleanUrl(url: string): string {
  return url.replace(postfixRE, "");
}

export const isWindows = os.platform() === "win32";
/**根据操作系统，使用适当的路径分隔符（例如 / 或 \） */
export function normalizePath(id: string): string {
  return path.posix.normalize(isWindows ? slash(id) : id);
}
/**解析本地服务器地址 */
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

  const local: string[] = [];
  const network: string[] = [];
  const hostname = await resolveHostname(options.host);
  const protocol = options.https ? "https" : "http";
  const port = address.port;
  const base =
    config.rawBase === "./" || config.rawBase === "" ? "/" : config.rawBase;

  if (hostname.host && loopbackHosts.has(hostname.host)) {
    let hostnameName = hostname.name;
    if (hostnameName.includes(":")) {
      hostnameName = `[${hostnameName}]`;
    }
    local.push(`${protocol}://${hostnameName}:${port}${base}`);
  } else {
    Object.values(os.networkInterfaces())
      .flatMap((nInterface) => nInterface ?? [])
      .filter(
        (detail) =>
          detail &&
          detail.address &&
          (detail.family === "IPv4" ||
            // @ts-expect-error Node 18.0- 18.3 returns number
            detail.family === 4)
      )
      .forEach((detail) => {
        let host = detail.address.replace("127.0.0.1", hostname.name);
        if (host.includes(":")) {
          host = `[${host}]`;
        }
        const url = `${protocol}://${host}:${port}${base}`;
        if (detail.address.includes("127.0.0.1")) {
          local.push(url);
        } else {
          network.push(url);
        }
      });
  }
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
/**将文件添加到热更新监听中 */
export function ensureWatchedFile(
  watcher: FSWatcher,
  file: string | null,
  root: string
): void {
  if (
    file &&
    !file.startsWith(root + "/") &&
    !file.includes("\0") &&
    fs.existsSync(file)
  ) {
    watcher.add(path.resolve(file));
  }
}
/**比较数组顺序、元素、长度是否相等 */
export function arrayEqual(a: any[], b: any[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
/**
 * 用于检测 DNS 解析顺序变化的函数
 * 不同的 DNS 解析器可能会以不同的顺序解析相同的域名，
 * 这可能导致在不同的环境中获取到不同的 IP 地址
 */
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
/**将多个URL片段组合成一个完整的URL路径 */
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

export function getShortName(file: string, root: string) {
  return file.startsWith(root + "/") ? path.posix.relative(root, file) : file;
}
/**查找package.json文件 */
export function lookupFile(
  dir: string,
  fileNames: string[]
): string | undefined {
  while (dir) {
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
    // fs.statSync: 获取文件信息 throwIfNoEntry <boolean> 如果文件系统条目不存在，
    // 是否会抛出异常。 默认值: true。
    return fs.statSync(file, { throwIfNoEntry: false });
  } catch (e) {}
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

export const isExternalUrl = (url: string): boolean => externalRE.test(url);

export function moduleListContains(
  moduleList: string[] | undefined,
  id: string
): boolean | undefined {
  return moduleList?.some((m) => m === id || id.startsWith(m + "/"));
}
// @ts-expect-error jest only exists when running Jest
export const usingDynamicImport = typeof jest === "undefined";

const _require = createRequire(import.meta.url);
export const dynamicImport = usingDynamicImport
  ? new Function("file", "return import(file)") // NOTE
  : _require;

const knownTsRE = /\.(?:ts|mts|cts|tsx)(?:$|\?)/;
export const isTsRequest = (url: string): boolean => knownTsRE.test(url);

const windowsDrivePathPrefixRE = /^[A-Za-z]:[/\\]/;
export const isNonDriveRelativeAbsolutePath = (p: string): boolean => {
  if (!isWindows) return p[0] === "/";
  return windowsDrivePathPrefixRE.test(p);
};

export const isDataUrl = (url: string): boolean => dataUrlRE.test(url);

export const bareImportRE = /^[\w@](?!.*:\/\/)/;
export const deepImportRE = /^([^@][^/]*)\/|^(@[^/]+\/[^/]+)\//;
const parseNetUseRE = /^(\w+)? +(\w:) +([^ ]+)\s/;

const windowsNetworkMap = new Map();
function windowsMappedRealpathSync(path: string) {
  const realPath = fs.realpathSync.native(path);
  if (realPath.startsWith("\\\\")) {
    for (const [network, volume] of windowsNetworkMap) {
      if (realPath.startsWith(network))
        return realPath.replace(network, volume);
    }
  }
  return realPath;
}
/**NOTE:优化获取真实路径 */
function optimizeSafeRealPathSync() {
  const nodeVersion = process.versions.node.split(".").map(Number);
  if (nodeVersion[0] < 16 || (nodeVersion[0] === 16 && nodeVersion[1] < 18)) {
    safeRealpathSync = fs.realpathSync;
    return;
  }

  exec("net use", (error, stdout) => {
    if (error) return;
    const lines = stdout.split("\n");
    for (const line of lines) {
      const m = line.match(parseNetUseRE);
      if (m) windowsNetworkMap.set(m[3], m[2]);
    }
    if (windowsNetworkMap.size === 0) {
      safeRealpathSync = fs.realpathSync.native;
    } else {
      safeRealpathSync = windowsMappedRealpathSync;
    }
  });
}

let firstSafeRealPathSyncRun = false;
function windowsSafeRealPathSync(path: string): string {
  if (!firstSafeRealPathSyncRun) {
    optimizeSafeRealPathSync();
    firstSafeRealPathSyncRun = true;
  }
  return fs.realpathSync(path);
}

export let safeRealpathSync = isWindows
  ? windowsSafeRealPathSync
  : fs.realpathSync.native;

export function isOptimizable(
  id: string,
  optimizeDeps: DepOptimizationConfig
): boolean {
  const { extensions } = optimizeDeps;
  return (
    OPTIMIZABLE_ENTRY_RE.test(id) ||
    (extensions?.some((ext) => id.endsWith(ext)) ?? false)
  );
}

export const multilineCommentsRE = /\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g;
export const singlelineCommentsRE = /\/\/.*/g;
/**
 * 从字符串中移除 Unicode 字节顺序标记
 * '\uFEFFHello, World!' 输出 "Hello, World!"
 * */
export function stripBomTag(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }

  return content;
}
const importQueryRE = /(\?|&)import=?(?:&|$)/;
const trailingSeparatorRE = /[?&]$/;

export function removeImportQuery(url: string): string {
  return url.replace(importQueryRE, "$1").replace(trailingSeparatorRE, "");
}
const timestampRE = /\bt=\d{13}&?\b/;
/**移除时间戳参数 */
export function removeTimestampQuery(url: string): string {
  return url.replace(timestampRE, "").replace(trailingSeparatorRE, "");
}

export function fsPathFromUrl(url: string): string {
  return fsPathFromId(cleanUrl(url));
}

export function transformStableResult(s: MagicString): TransformResult {
  return {
    code: s.toString(),
    map: null,
  };
}
/**移除字符串开头的斜杠 */
export function removeLeadingSlash(str: string): string {
  return str[0] === "/" ? str.slice(1) : str;
}

const directRequestRE = /(\?|&)direct=?(?:&|$)/;

export function removeDirectQuery(url: string): string {
  return url.replace(directRequestRE, "$1").replace(trailingSeparatorRE, "");
}

const _dirname = path.dirname(fileURLToPath(import.meta.url));
export const requireResolveFromRootWithFallback = (
  root: string,
  id: string
): string => {
  const found =
    resolvePackageData(id, root) || resolvePackageData(id, _dirname);
  if (!found) {
    const error = new Error(`${JSON.stringify(id)} not found.`);
    (error as any).code = "MODULE_NOT_FOUND";
    throw error;
  }
  return _require.resolve(id, { paths: [root, _dirname] });
};

export async function asyncReplace(
  input: string,
  re: RegExp,
  replacer: (match: RegExpExecArray) => string | Promise<string>
): Promise<string> {
  let match: RegExpExecArray | null;
  let remaining = input;
  let rewritten = "";
  while ((match = re.exec(remaining))) {
    rewritten += remaining.slice(0, match.index);
    rewritten += await replacer(match);
    remaining = remaining.slice(match.index + match[0].length);
  }
  rewritten += remaining;
  return rewritten;
}

const internalPrefixes = [
  FS_PREFIX,
  VALID_ID_PREFIX,
  CLIENT_PUBLIC_PATH,
  ENV_PUBLIC_PATH,
];
const InternalPrefixRE = new RegExp(`^(?:${internalPrefixes.join("|")})`);
export const isInternalRequest = (url: string): boolean =>
  InternalPrefixRE.test(url);

export function isFileReadable(filename: string): boolean {
  try {
    if (!fs.statSync(filename, { throwIfNoEntry: false })) {
      return false;
    }

    fs.accessSync(filename, fs.constants.R_OK);

    return true;
  } catch (e) {
    return false;
  }
}
export const isCaseInsensitiveFS = testCaseInsensitiveFS();
function testCaseInsensitiveFS() {
  if (!CLIENT_ENTRY.endsWith("client.mjs")) {
    throw new Error(
      `cannot test case insensitive FS, CLIENT_ENTRY const doesn't contain client.mjs`
    );
  }
  if (!fs.existsSync(CLIENT_ENTRY)) {
    throw new Error(
      "cannot test case insensitive FS, CLIENT_ENTRY does not point to an existing file: " +
        CLIENT_ENTRY
    );
  }
  return fs.existsSync(CLIENT_ENTRY.replace("client.mjs", "cLiEnT.mjs"));
}
export function isParentDirectory(dir: string, file: string): boolean {
  if (dir[dir.length - 1] !== "/") {
    dir = `${dir}/`;
  }
  return (
    file.startsWith(dir) ||
    (isCaseInsensitiveFS && file.toLowerCase().startsWith(dir.toLowerCase()))
  );
}

export function timeFrom(start: number, subtract = 0): string {
  const time: number | string = performance.now() - start - subtract;
  const timeString = (time.toFixed(2) + `ms`).padEnd(5, " ");
  if (time < 10) {
    return colors.green(timeString);
  } else if (time < 50) {
    return colors.yellow(timeString);
  } else {
    return colors.red(timeString);
  }
}

export interface Hostname {
  host: string | undefined;
  name: string;
}

export async function resolveHostname(
  optionsHost: string | boolean | undefined
): Promise<Hostname> {
  let host: string | undefined;
  if (optionsHost === undefined || optionsHost === false) {
    host = "localhost";
  } else if (optionsHost === true) {
    host = undefined;
  } else {
    host = optionsHost;
  }

  let name = host === undefined || wildcardHosts.has(host) ? "localhost" : host;

  if (host === "localhost") {
    const localhostAddr = await getLocalhostAddressIfDiffersFromDNS();
    if (localhostAddr) {
      name = localhostAddr;
    }
  }

  return { host, name };
}

export async function getLocalhostAddressIfDiffersFromDNS(): Promise<
  string | undefined
> {
  const [nodeResult, dnsResult] = await Promise.all([
    dns.lookup("localhost"),
    dns.lookup("localhost", { verbatim: true }),
  ]);
  const isSame =
    nodeResult.family === dnsResult.family &&
    nodeResult.address === dnsResult.address;
  return isSame ? undefined : nodeResult.address;
}

export const isImportRequest = (url: string): boolean =>
  importQueryRE.test(url);

export function prettifyUrl(url: string, root: string): string {
  url = removeTimestampQuery(url);
  const isAbsoluteFile = url.startsWith(root);
  if (isAbsoluteFile || url.startsWith(FS_PREFIX)) {
    const file = path.relative(root, isAbsoluteFile ? url : fsPathFromId(url));
    return colors.dim(file);
  } else {
    return colors.dim(url);
  }
}

export function pad(source: string, n = 2): string {
  const lines = source.split(splitRE);
  return lines.map((l) => ` `.repeat(n) + l).join(`\n`);
}

export function evalValue<T = any>(rawValue: string): T {
  const fn = new Function(`
    var console, exports, global, module, process, require
    return (\n${rawValue}\n)
  `);
  return fn();
}

function normalizeSingleAlias({
  find,
  replacement,
  customResolver,
}: Alias): Alias {
  if (
    typeof find === "string" &&
    find[find.length - 1] === "/" &&
    replacement[replacement.length - 1] === "/"
  ) {
    find = find.slice(0, find.length - 1);
    replacement = replacement.slice(0, replacement.length - 1);
  }

  const alias: Alias = {
    find,
    replacement,
  };
  if (customResolver) {
    alias.customResolver = customResolver;
  }
  return alias;
}
/**
 * normalizeAlias 函数用于规范化别名配置。
 * 确保别名路径以 / 开头：如果别名路径不以 / 开头，则会在前面添加 /。
 * 确保别名路径以 / 结尾：如果别名路径不以 / 结尾，则会在末尾添加 /。
 * 处理别名路径中的 ~ 符号：将别名路径中的 ~ 替换为根目录路径。
 */
export function normalizeAlias(o: AliasOptions = []): Alias[] {
  return Array.isArray(o)
    ? o.map(normalizeSingleAlias)
    : Object.keys(o).map((find) =>
        normalizeSingleAlias({
          find,
          replacement: (o as any)[find],
        })
      );
}

export function mergeAlias(
  a?: AliasOptions,
  b?: AliasOptions
): AliasOptions | undefined {
  if (!a) return b;
  if (!b) return a;
  if (isObject(a) && isObject(b)) {
    return { ...a, ...b };
  }
  return [...normalizeAlias(b), ...normalizeAlias(a)];
}

export function shouldServeFile(filePath: string, root: string): boolean {
  if (!isCaseInsensitiveFS) return true;

  return hasCorrectCase(filePath, root);
}

function hasCorrectCase(file: string, assets: string): boolean {
  if (file === assets) return true;

  const parent = path.dirname(file);

  if (fs.readdirSync(parent).includes(path.basename(file))) {
    return hasCorrectCase(parent, assets);
  }
  return false;
}
