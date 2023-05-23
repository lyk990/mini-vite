import colors from 'picocolors'
import type { RollupError } from "rollup";
import type { ResolvedServerUrls } from './server'
export type LogType = "error" | "warn" | "info";
export type LogLevel = LogType | 'silent'
export interface Logger {
  info(msg: string, options?: LogOptions): void;
  warn(msg: string, options?: LogOptions): void;
  warnOnce(msg: string, options?: LogOptions): void;
  error(msg: string, options?: LogErrorOptions): void;
  // clearScreen(type: LogType): void;
  hasErrorLogged(error: Error | RollupError): boolean;
  hasWarned: boolean;
}
export interface LogOptions {
  clear?: boolean;
  timestamp?: boolean;
}
export interface LogErrorOptions extends LogOptions {
  error?: Error | RollupError | null;
}
export function printServerUrls(
  urls: ResolvedServerUrls,
  optionsHost: string | boolean | undefined,
  info: Logger["info"]
): void {
  const colorUrl = (url: string) =>
    colors.cyan(url.replace(/:(\d+)\//, (_, port) => `:${colors.bold(port)}/`));
  for (const url of urls.local) {
    info(`  ${colors.green("➜")}  ${colors.bold("Local")}:   ${colorUrl(url)}`);
  }
  for (const url of urls.network) {
    info(`  ${colors.green("➜")}  ${colors.bold("Network")}: ${colorUrl(url)}`);
  }
  if (urls.network.length === 0 && optionsHost === undefined) {
    info(
      colors.dim(`  ${colors.green("➜")}  ${colors.bold("Network")}: use `) +
        colors.bold("--host") +
        colors.dim(" to expose")
    );
  }
}
