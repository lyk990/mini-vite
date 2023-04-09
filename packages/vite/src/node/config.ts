import {
  Alias,
  DepOptimizationOptions,
  InlineConfig,
  ResolveOptions,
  UserConfigExport,
} from "vite";
import { createLogger } from "vite";
import { DEFAULT_EXTENSIONS, DEFAULT_MAIN_FIELDS } from "./constants";
import { Logger } from "./logger";

import type { ResolvedServerOptions } from "./server";

// TODO
export interface ResolvedConfig {
  logger: Logger;
  server: ResolvedServerOptions;
  root: string;
  optimizeDeps: DepOptimizationOptions;
  resolve: Required<ResolveOptions> & {
    alias: Alias[];
  };
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
  // TODO
   // resolve alias with internal client alias
  //  const resolvedAlias = normalizeAlias(
  //   mergeAlias(clientAlias, config.resolve?.alias || []),
  // )
  const optimizeDeps = config.optimizeDeps || {};
  const resolveOptions: ResolvedConfig["resolve"] = {
    mainFields: config.resolve?.mainFields ?? DEFAULT_MAIN_FIELDS,
    browserField: config.resolve?.browserField ?? true,
    conditions: config.resolve?.conditions ?? [],
    extensions: config.resolve?.extensions ?? DEFAULT_EXTENSIONS,
    dedupe: config.resolve?.dedupe ?? [],
    preserveSymlinks: config.resolve?.preserveSymlinks ?? false,
    alias: [{ find: "", replacement: "@" }],
  };
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
    resolve: resolveOptions,
    optimizeDeps: {
      disabled: "build",
      ...optimizeDeps,
      esbuildOptions: {
        preserveSymlinks: resolveOptions.preserveSymlinks,
        ...optimizeDeps.esbuildOptions,
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
