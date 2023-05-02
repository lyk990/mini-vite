import os from "os";
import path from "node:path";
import type { AddressInfo, Server } from "node:net";
import type { CommonServerOptions } from "vite";
import type { ResolvedConfig } from "./config";
import type { ResolvedServerUrls, ViteDevServer } from "./server";
import debug from "debug";
import type { FSWatcher } from "chokidar";
import fs from "node:fs";
import { FS_PREFIX } from "./constants";

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

export function normalizePath(id: string): string {
  return path.posix.normalize(isWindows ? slash(id) : id);
}
// TODO
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
