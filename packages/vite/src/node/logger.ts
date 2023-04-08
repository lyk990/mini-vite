import type { RollupError } from "rollup";
export type LogType = 'error' | 'warn' | 'info'

export interface Logger {
  info(msg: string, options?: LogOptions): void;
  warn(msg: string, options?: LogOptions): void;
  warnOnce(msg: string, options?: LogOptions): void;
  error(msg: string, options?: LogErrorOptions): void;
  clearScreen(type: LogType): void;
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
