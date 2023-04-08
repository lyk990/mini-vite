import { InlineConfig, UserConfigExport } from "vite";
import { createLogger } from "vite";
import { Logger } from "./logger";

import type { ResolvedServerOptions } from "./server";

// TODO
export interface ResolvedConfig {
  logger: Logger;
  server: ResolvedServerOptions;
  root: string;
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
    root: process.cwd(),
    server: {
      preTransformRequests: true,
      middlewareMode: true,
      host: "localhost",
      // TODO
      fs: {
        strict: true,
        allow: [""],
        deny: [".env", ".env.*", "*.{crt,pem}"],
      },
    },
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
