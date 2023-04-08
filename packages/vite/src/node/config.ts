import { InlineConfig, UserConfigExport } from "vite";
import { createLogger } from "vite";
import { Logger } from "./logger";

// import type { ResolvedConfig } from "vite";

// TODO
export interface ResolvedConfig {
  logger: Logger;
}

export async function resolveConfig(
  inlineConfig: InlineConfig,
  command: "build" | "serve",
  defaultMode = "development",
  defaultNodeEnv = "development"
): Promise<ResolvedConfig> {
  let config = inlineConfig;
  // @ts-ignore TODO
  const configEnv = {
    mode: defaultMode,
    command: command,
    ssrBuild: !!config.build?.ssr,
  };
  const logger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  });
  const resolvedConfig: ResolvedConfig = {
    logger,
  };
  const resolved: ResolvedConfig = {
    ...config,
    ...resolvedConfig,
  };
  return resolved;
}

export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config;
}
