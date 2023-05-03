import path from "node:path";
import {
  Alias,
  DepOptimizationConfig,
  DepOptimizationOptions,
  HookHandler,
  InlineConfig,
  loadConfigFromFile,
  loadEnv,
  mergeConfig,
  resolveBaseUrl,
  ResolvedBuildOptions,
  ResolveOptions,
  UserConfig,
  UserConfigExport,
} from "vite";
import { createLogger } from "vite";
import { resolveBuildOptions } from "./build";
import { DEFAULT_EXTENSIONS, DEFAULT_MAIN_FIELDS } from "./constants";
import { resolveEnvPrefix } from "./env";
import { Logger } from "./logger";
import { Plugin } from "./plugin";

import type { ResolvedServerOptions } from "./server";
import { asyncFlatten, normalizePath } from "./utils";

export type AppType = "spa" | "mpa" | "custom";
// TODO
export type ResolvedConfig = Readonly<
  Omit<UserConfig, "plugins" | "assetsInclude" | "optimizeDeps" | "worker"> & {
    logger: Logger;
    server: ResolvedServerOptions;
    root: string;
    optimizeDeps: DepOptimizationOptions;
    resolve: Required<ResolveOptions> & {
      alias: Alias[];
    };
    build: ResolvedBuildOptions;
    configFile: string | undefined;
    configFileDependencies: string[];
    inlineConfig: InlineConfig;
    appType: AppType;
    plugins: readonly Plugin[];
    define?: Record<string, any>;
    env: Record<string, any>;
    envPrefix?: string | string[];
    base: string;
    publicDir?: string | false;
  } & PluginHookUtils
>;

export interface PluginHookUtils {
  getSortedPlugins: (hookName: keyof Plugin) => Plugin[];
  getSortedPluginHooks: <K extends keyof Plugin>(
    hookName: K
  ) => NonNullable<HookHandler<Plugin[K]>>[];
}
export async function resolveConfig(
  inlineConfig: InlineConfig,
  command: "build" | "serve",
  defaultMode = "development",
  defaultNodeEnv = "development"
): Promise<ResolvedConfig> {
  let config = inlineConfig;
  let configFileDependencies: string[] = [];
  let mode = inlineConfig.mode || defaultMode;

  // @ts-ignore
  const configEnv = {
    mode: defaultMode,
    command: command,
    ssrBuild: !!config.build?.ssr,
  };
  const logger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  });
  let { configFile } = config;
  if (configFile !== false) {
    const loadResult = await loadConfigFromFile(
      configEnv,
      configFile,
      config.root,
      config.logLevel
    );
    if (loadResult) {
      config = mergeConfig(loadResult.config, config);
      configFile = loadResult.path;
      configFileDependencies = loadResult.dependencies;
    }
  }
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
  const resolvedRoot = normalizePath(
    config.root ? path.resolve(config.root) : process.cwd()
  );
  const resolvedBuildOptions = resolveBuildOptions(
    config.build,
    logger,
    resolvedRoot
  );
  mode = inlineConfig.mode || config.mode || mode;
  const filterPlugin = (p: Plugin) => {
    if (!p) {
      return false;
    } else if (!p.apply) {
      return true;
    } else if (typeof p.apply === "function") {
      return p.apply({ ...config, mode }, configEnv);
    } else {
      return p.apply === command;
    }
  };
  // const rawWorkerUserPlugins = (
  //   (await asyncFlatten(config.worker?.plugins || [])) as Plugin[]
  // ).filter(filterPlugin);

  const rawUserPlugins = (
    (await asyncFlatten(config.plugins || [])) as Plugin[]
  ).filter(filterPlugin);

  const [prePlugins, normalPlugins, postPlugins] =
    sortUserPlugins(rawUserPlugins);
  const middlewareMode = config?.server?.middlewareMode;
  const userPlugins = [...prePlugins, ...normalPlugins, ...postPlugins];

  const isBuild = command === "build";
  const relativeBaseShortcut = config.base === "" || config.base === "./";

  const resolvedBase = relativeBaseShortcut
    ? true || config.build?.ssr
      ? "/"
      : "./"
    : resolveBaseUrl(config.base, isBuild, logger) ?? "/";
  const BASE_URL = resolvedBase;

  const envDir = config.envDir
    ? normalizePath(path.resolve(resolvedRoot, config.envDir))
    : resolvedRoot;

  const userEnv =
    inlineConfig.envFile !== false &&
    loadEnv(mode, envDir, resolveEnvPrefix(config));

  const resolvedConfig: ResolvedConfig = {
    configFile: configFile ? normalizePath(configFile) : undefined,
    configFileDependencies: configFileDependencies.map((name) =>
      normalizePath(path.resolve(name))
    ),
    inlineConfig,
    logger,
    root: process.cwd(),
    base: resolvedBase.endsWith("/") ? resolvedBase : resolvedBase + "/",
    env: {
      ...userEnv,
      BASE_URL,
      MODE: mode,
      DEV: true,
      PROD: false,
    },
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
    build: resolvedBuildOptions,
    appType: config.appType ?? (middlewareMode === "ssr" ? "custom" : "spa"),
    plugins: userPlugins,
    getSortedPluginHooks: undefined!,
    getSortedPlugins: undefined!,
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

export function sortUserPlugins(
  plugins: (Plugin | Plugin[])[] | undefined
): [Plugin[], Plugin[], Plugin[]] {
  const prePlugins: Plugin[] = [];
  const postPlugins: Plugin[] = [];
  const normalPlugins: Plugin[] = [];

  if (plugins) {
    plugins.flat().forEach((p) => {
      if (p.enforce === "pre") prePlugins.push(p);
      else if (p.enforce === "post") postPlugins.push(p);
      else normalPlugins.push(p);
    });
  }

  return [prePlugins, normalPlugins, postPlugins];
}

export function getDepOptimizationConfig(
  config: ResolvedConfig,
  ssr: boolean
): DepOptimizationConfig {
  // @ts-ignore
  return ssr ? config?.ssr.optimizeDeps : config.optimizeDeps;
}
