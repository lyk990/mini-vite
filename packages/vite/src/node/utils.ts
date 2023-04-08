import os from "os";
import path from "node:path";
import type { AddressInfo, Server } from "node:net";
import type { CommonServerOptions } from "vite";
import type { ResolvedConfig } from "./config";
import type { ResolvedServerUrls } from "./server";

export function slash(p: string): string {
  return p.replace(/\\/g, "/");
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
