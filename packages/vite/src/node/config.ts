import path from "node:path";
import {
  Alias,
  ConfigEnv,
  DepOptimizationConfig,
  DepOptimizationOptions,
  HookHandler,
  InlineConfig,
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
import {
  DEFAULT_CONFIG_FILES,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAIN_FIELDS,
} from "./constants";
import { resolveEnvPrefix } from "./env";
import { Logger, LogLevel } from "./logger";
import { Plugin } from "./plugin";

import type { ResolvedServerOptions } from "./server";
import {
  asyncFlatten,
  createDebugger,
  lookupFile,
  normalizePath,
} from "./utils";
import fs from "node:fs";

const debug = createDebugger("vite:config");

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
  // let mode = inlineConfig.mode || defaultMode;
  let mode = "development";
  const configEnv = {
    mode,
    command,
    // ssrBuild: !!config.build?.ssr,
    ssrBuild: false,
  };
  const logger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  });
  let { configFile } = config;
  if (configFile !== false) {
    // loadResult = {
    //   path: "C:/Users/Administrator/Desktop/learn-Code/vite源码/mini-vite/mini-vite-example/vite.config.ts",
    //   config: { plugins: [ vue() ], },
    //   dependencies: [ "vite.config.ts",],
    // }
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

/**根据相关目录获取配置文件 */
export async function loadConfigFromFile(
  configEnv: ConfigEnv,
  configFile?: string,
  configRoot: string = process.cwd(),
  logLevel?: LogLevel
): Promise<{
  path: string;
  config: UserConfig;
  dependencies: string[];
} | null> {
  const start = performance.now();
  const getTime = () => `${(performance.now() - start).toFixed(2)}ms`;

  let resolvedPath: string | undefined;
  // configFile === undefined, 有配置文件就直接解析出路径
  if (configFile) {
    resolvedPath = path.resolve(configFile);
  } else {
    // entry point
    // 没有配置文件，就遍历默认配置文件 DEFAULT_CONFIG_FILES  'vite.config.js',
    for (const filename of DEFAULT_CONFIG_FILES) {
      const filePath = path.resolve(configRoot, filename);
      //fs.existsSync() 同步方法用于检测文件是否存在，返回布尔值类型
      if (!fs.existsSync(filePath)) continue;
      resolvedPath = filePath;
      break;
    }
  }
  // resolvedPath = "C:\\Users\\Administrator\\Desktop\\learn-Code\\vite源码\\mini-vite\\mini-vite-example\\vite.config.ts"
  if (!resolvedPath) {
    debug?.("no config file found.");
    return null;
  }
  // 判断是否是esm模块
  let isESM = false;
  if (/\.m[jt]s$/.test(resolvedPath)) {
    isESM = true;
  } else if (/\.c[jt]s$/.test(resolvedPath)) {
    isESM = false;
  } else {
    // entry point
    try {
      // configRoot = 'C:\\Users\\Administrator\\Desktop\\learn-Code\\vite源码\\mini-vite\\mini-vite-example'
      const pkg = lookupFile(configRoot, ["package.json"]);
      isESM =
        !!pkg && JSON.parse(fs.readFileSync(pkg, "utf-8")).type === "module";
    } catch (e) {}
  }

  try {
    const bundled = await bundleConfigFile(resolvedPath, isESM);
    const userConfig = await loadConfigFromBundledFile(
      resolvedPath,
      bundled.code,
      isESM
    );
    debug?.(`bundled config file loaded in ${getTime()}`);

    const config = await (typeof userConfig === "function"
      ? userConfig(configEnv)
      : userConfig);
    if (!isObject(config)) {
      throw new Error(`config must export or return an object.`);
    }
    return {
      path: normalizePath(resolvedPath),
      config,
      dependencies: bundled.dependencies,
    };
  } catch (e) {
    createLogger(logLevel).error(
      colors.red(`failed to load config from ${resolvedPath}`),
      { error: e }
    );
    throw e;
  }
}
