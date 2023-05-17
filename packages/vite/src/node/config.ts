import path from "node:path";
import {
  Alias,
  ConfigEnv,
  DepOptimizationConfig,
  DepOptimizationOptions,
  ESBuildOptions,
  ExperimentalOptions,
  HookHandler,
  InlineConfig,
  InternalResolveOptions,
  mergeConfig,
  resolveBaseUrl,
  ResolvedBuildOptions,
  UserConfig,
  UserConfigExport,
} from "vite";
import { createLogger } from "vite";
import { resolveBuildOptions } from "./build";
import {
  CLIENT_ENTRY,
  DEFAULT_ASSETS_RE,
  DEFAULT_CONFIG_FILES,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAIN_FIELDS,
  ENV_ENTRY,
  FS_PREFIX,
} from "./constants";
import { Logger, LogLevel } from "./logger";
import { Plugin } from "./plugin";
import { createRequire } from "node:module";
import { ResolvedServerOptions, resolveServerOptions } from "./server";
import {
  asyncFlatten,
  createDebugger,
  createFilter,
  dynamicImport,
  isBuiltin,
  isObject,
  lookupFile,
  mergeAlias,
  normalizeAlias,
  normalizePath,
} from "./utils";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { build } from "esbuild";
import { InternalResolveOptionsWithOverrideConditions } from "./plugins/resolve";
import colors from "picocolors";
import { pathToFileURL } from "node:url";
import { findNearestPackageData, PackageCache } from "./packages";
import { PluginContainer, createPluginContainer } from "./pluginContainer";
import aliasPlugin from "@rollup/plugin-alias";
import { promisify } from "node:util";
import { resolvePlugin, tryNodeResolve } from "./plugins/resolve";
import {
  createPluginHookUtils,
  getSortedPluginsByHook,
  resolvePlugins,
} from "./plugins";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import type { ProxyOptions } from "./server/middlewares/proxy";
import type { OutgoingHttpHeaders as HttpServerHeaders } from "node:http";
import { loadEnv, resolveEnvPrefix } from "./env";
import { resolveSSROptions } from "./ssr";
import { RollupOptions } from "rollup";

const debug = createDebugger("vite:config");
const promisifiedRealpath = promisify(fs.realpath);

export type CorsOrigin = boolean | string | RegExp | (string | RegExp)[];
export interface ResolveWorkerOptions extends PluginHookUtils {
  format: "es" | "iife";
  plugins: Plugin[];
  rollupOptions: RollupOptions;
}

export interface CorsOptions {
  origin?:
    | CorsOrigin
    | ((origin: string, cb: (err: Error, origins: CorsOrigin) => void) => void);
  methods?: string | string[];
  allowedHeaders?: string | string[];
  exposedHeaders?: string | string[];
  credentials?: boolean;
  maxAge?: number;
  preflightContinue?: boolean;
  optionsSuccessStatus?: number;
}

export interface CommonServerOptions {
  port?: number;
  strictPort?: boolean;
  host?: string | boolean;
  https?: boolean | HttpsServerOptions;
  open?: boolean | string;
  proxy?: Record<string, string | ProxyOptions>;
  cors?: CorsOptions | boolean;
  headers?: HttpServerHeaders;
}

export type ResolveFn = (
  id: string,
  importer?: string,
  aliasOnly?: boolean,
  ssr?: boolean
) => Promise<string | undefined>;

interface NodeModuleWithCompile extends NodeModule {
  _compile(code: string, filename: string): any;
}

export interface ResolveOptions {
  mainFields?: string[];
  browserField?: boolean;
  conditions?: string[];
  extensions?: string[];
  dedupe?: string[];
  preserveSymlinks?: boolean;
}

export type AppType = "spa" | "mpa" | "custom";
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
    cacheDir: string;
    appType: AppType;
    plugins: readonly Plugin[];
    define?: Record<string, any>;
    env: Record<string, any>;
    envPrefix?: string | string[];
    base: string;
    publicDir: string;
    command: "build" | "serve";
    createResolver: (options?: Partial<InternalResolveOptions>) => ResolveFn;
    isProduction: boolean;
    assetsInclude: (file: string) => boolean;
    packageCache: PackageCache;
    envDir: string;
    isWorker: boolean; // FEATURE worker打包
    experimental: ExperimentalOptions;
    mode: string;
    esbuild: ESBuildOptions | false;
    rawBase: string; // REMOVE
    mainConfig: ResolvedConfig | null; // REMOVE
    worker: ResolveWorkerOptions; // REMOVE
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
  const isNodeEnvSet = !!process.env.NODE_ENV;
  const packageCache: PackageCache = new Map();

  if (!isNodeEnvSet) {
    process.env.NODE_ENV = defaultNodeEnv;
  }

  const configEnv = {
    mode,
    command,
    ssrBuild: !!config.build?.ssr,
  };

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

  mode = inlineConfig.mode || config.mode || mode;
  configEnv.mode = mode;

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

  const rawWorkerUserPlugins = (
    (await asyncFlatten(config.worker?.plugins || [])) as Plugin[]
  ).filter(filterPlugin);

  const rawUserPlugins = (
    (await asyncFlatten(config.plugins || [])) as Plugin[]
  ).filter(filterPlugin);

  const [prePlugins, normalPlugins, postPlugins] =
    sortUserPlugins(rawUserPlugins);

  const userPlugins = [...prePlugins, ...normalPlugins, ...postPlugins];
  config = await runConfigHook(config, userPlugins, configEnv);

  if (process.env.VITE_TEST_WITHOUT_PLUGIN_COMMONJS) {
    config = mergeConfig(config, {
      optimizeDeps: { disabled: false },
      ssr: { optimizeDeps: { disabled: false } },
    });
    config.build ??= {};
    config.build.commonjsOptions = { include: [] };
  }

  const logger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  });

  const resolvedRoot = normalizePath(
    config.root ? path.resolve(config.root) : process.cwd()
  );

  const clientAlias = [
    {
      find: /^\/?@vite\/env/,
      replacement: path.posix.join(FS_PREFIX, normalizePath(ENV_ENTRY)),
    },
    {
      find: /^\/?@vite\/client/,
      replacement: path.posix.join(FS_PREFIX, normalizePath(CLIENT_ENTRY)),
    },
  ];

  const resolvedAlias = normalizeAlias(
    mergeAlias(clientAlias, config.resolve?.alias || [])
  );

  const resolveOptions: ResolvedConfig["resolve"] = {
    mainFields: config.resolve?.mainFields ?? DEFAULT_MAIN_FIELDS,
    browserField: config.resolve?.browserField ?? true,
    conditions: config.resolve?.conditions ?? [],
    extensions: config.resolve?.extensions ?? DEFAULT_EXTENSIONS,
    dedupe: config.resolve?.dedupe ?? [],
    preserveSymlinks: config.resolve?.preserveSymlinks ?? false,
    alias: resolvedAlias,
  };

  const envDir = config.envDir
    ? normalizePath(path.resolve(resolvedRoot, config.envDir))
    : resolvedRoot;
  const userEnv =
    inlineConfig.envFile !== false &&
    loadEnv(mode, envDir, resolveEnvPrefix(config));

  const userNodeEnv = process.env.VITE_USER_NODE_ENV;
  if (!isNodeEnvSet && userNodeEnv) {
    if (userNodeEnv === "development") {
      process.env.NODE_ENV = "development";
    } else {
      logger.warn(
        `NODE_ENV=${userNodeEnv} is not supported in the .env file. ` +
          `Only NODE_ENV=development is supported to create a development build of your project. ` +
          `If you need to set process.env.NODE_ENV, you can set it in the Vite config instead.`
      );
    }
  }

  const isProduction = process.env.NODE_ENV === "production";

  const isBuild = command === "build";
  const relativeBaseShortcut = config.base === "" || config.base === "./";

  const resolvedBase = relativeBaseShortcut
    ? !isBuild || config.build?.ssr
      ? "/"
      : "./"
    : resolveBaseUrl(config.base, isBuild, logger) ?? "/";

  const resolvedBuildOptions = resolveBuildOptions(
    config.build,
    logger,
    resolvedRoot
  );

  const pkgDir = findNearestPackageData(resolvedRoot, packageCache)?.dir;
  const cacheDir = normalizePath(
    config.cacheDir
      ? path.resolve(resolvedRoot, config.cacheDir)
      : pkgDir
      ? path.join(pkgDir, `node_modules/.vite`)
      : path.join(resolvedRoot, `.vite`)
  );

  const assetsFilter =
    config.assetsInclude &&
    (!Array.isArray(config.assetsInclude) || config.assetsInclude.length)
      ? createFilter(config.assetsInclude)
      : () => false;
  const createResolver: ResolvedConfig["createResolver"] = (options) => {
    let aliasContainer: PluginContainer | undefined;
    let resolverContainer: PluginContainer | undefined;
    return async (id, importer, aliasOnly, ssr) => {
      let container: PluginContainer;
      if (aliasOnly) {
        container =
          aliasContainer ||
          (aliasContainer = await createPluginContainer({
            ...resolved,
            plugins: [aliasPlugin({ entries: resolved.resolve.alias })],
          }));
      } else {
        container =
          resolverContainer ||
          (resolverContainer = await createPluginContainer({
            ...resolved,
            plugins: [
              aliasPlugin({ entries: resolved.resolve.alias }),
              resolvePlugin({
                ...resolved.resolve,
                root: resolvedRoot,
                isProduction,
                isBuild: command === "build",
                ssrConfig: resolved.ssr,
                asSrc: true,
                preferRelative: false,
                tryIndex: true,
                ...options,
                idOnly: true,
              } as any), // TODO ts类型不正确
            ],
          }));
      }
      return (
        await container.resolveId(id, importer, {
          ssr,
          scan: options?.scan,
        })
      )?.id;
    };
  };

  const { publicDir } = config;
  const resolvedPublicDir =
    publicDir !== false && publicDir !== ""
      ? path.resolve(
          resolvedRoot,
          typeof publicDir === "string" ? publicDir : "public"
        )
      : "";

  const server = resolveServerOptions(resolvedRoot, config.server, logger);
  const ssr = resolveSSROptions(
    config.ssr,
    resolveOptions.preserveSymlinks,
    config.legacy?.buildSsrCjsExternalHeuristics
  );

  const middlewareMode = config?.server?.middlewareMode;

  const optimizeDeps = config.optimizeDeps || {};

  const BASE_URL = resolvedBase;

  let workerConfig = mergeConfig({}, config);
  const [workerPrePlugins, workerNormalPlugins, workerPostPlugins] =
    sortUserPlugins(rawWorkerUserPlugins);

  const workerUserPlugins = [
    ...workerPrePlugins,
    ...workerNormalPlugins,
    ...workerPostPlugins,
  ];
  workerConfig = await runConfigHook(
    workerConfig,
    workerUserPlugins,
    configEnv
  );
  const resolvedWorkerOptions: ResolveWorkerOptions = {
    format: workerConfig.worker?.format || "iife",
    plugins: [],
    rollupOptions: workerConfig.worker?.rollupOptions || {},
    getSortedPlugins: undefined!,
    getSortedPluginHooks: undefined!,
  };

  const resolvedConfig: ResolvedConfig = {
    configFile: configFile ? normalizePath(configFile) : undefined,
    configFileDependencies: configFileDependencies.map((name) =>
      normalizePath(path.resolve(name))
    ),
    inlineConfig,
    root: resolvedRoot,
    base: resolvedBase.endsWith("/") ? resolvedBase : resolvedBase + "/",
    rawBase: resolvedBase,
    resolve: resolveOptions,
    publicDir: resolvedPublicDir,
    cacheDir,
    command,
    mode,
    ssr,
    isWorker: false,
    mainConfig: null,
    isProduction,
    plugins: userPlugins,
    esbuild:
      config.esbuild === false
        ? false
        : {
            jsxDev: !isProduction,
            ...config.esbuild,
          },
    server,
    build: resolvedBuildOptions,
    envDir,
    env: {
      ...userEnv,
      BASE_URL,
      MODE: mode,
      DEV: !isProduction,
      PROD: isProduction,
    },
    assetsInclude(file: string) {
      return DEFAULT_ASSETS_RE.test(file) || assetsFilter(file);
    },
    logger,
    packageCache,
    createResolver,
    optimizeDeps: {
      disabled: "build",
      ...optimizeDeps,
      esbuildOptions: {
        preserveSymlinks: resolveOptions.preserveSymlinks,
        ...optimizeDeps.esbuildOptions,
      },
    },
    worker: resolvedWorkerOptions,
    appType: config.appType ?? (middlewareMode === "ssr" ? "custom" : "spa"),
    experimental: {
      importGlobRestoreExtension: false,
      hmrPartialAccept: false,
      ...config.experimental,
    },
    getSortedPlugins: undefined!,
    getSortedPluginHooks: undefined!,
  };
  const resolved: ResolvedConfig = {
    ...config,
    ...resolvedConfig,
  };

  (resolved.plugins as Plugin[]) = await resolvePlugins(
    resolved,
    prePlugins,
    normalPlugins,
    postPlugins
  );
  Object.assign(resolved, createPluginHookUtils(resolved.plugins));

  const workerResolved: ResolvedConfig = {
    ...workerConfig,
    ...resolvedConfig,
    isWorker: true,
    mainConfig: resolved,
  };
  resolvedConfig.worker.plugins = await resolvePlugins(
    workerResolved,
    workerPrePlugins,
    workerNormalPlugins,
    workerPostPlugins
  );
  Object.assign(
    resolvedConfig.worker,
    createPluginHookUtils(resolvedConfig.worker.plugins)
  );

  // call configResolved hooks
  await Promise.all([
    ...resolved
      .getSortedPluginHooks("configResolved")
      .map((hook) => hook(resolved)),
    ...resolvedConfig.worker
      .getSortedPluginHooks("configResolved")
      .map((hook) => hook(workerResolved)),
  ]);

  // validate config

  if (middlewareMode === "ssr") {
    logger.warn(
      colors.yellow(
        `Setting server.middlewareMode to 'ssr' is deprecated, set server.middlewareMode to \`true\`${
          config.appType === "custom" ? "" : ` and appType to 'custom'`
        } instead`
      )
    );
  }
  if (middlewareMode === "html") {
    logger.warn(
      colors.yellow(
        `Setting server.middlewareMode to 'html' is deprecated, set server.middlewareMode to \`true\` instead`
      )
    );
  }

  if (
    config.server?.force &&
    !isBuild &&
    config.optimizeDeps?.force === undefined
  ) {
    resolved.optimizeDeps.force = true;
    logger.warn(
      colors.yellow(
        `server.force is deprecated, use optimizeDeps.force instead`
      )
    );
  }

  debug?.(`using resolved config: %O`, {
    ...resolved,
    plugins: resolved.plugins.map((p) => p.name),
    worker: {
      ...resolved.worker,
      plugins: resolved.worker.plugins.map((p) => p.name),
    },
  });

  if (config.build?.terserOptions && config.build.minify !== "terser") {
    logger.warn(
      colors.yellow(
        `build.terserOptions is specified but build.minify is not set to use Terser. ` +
          `Note Vite now defaults to use esbuild for minification. If you still ` +
          `prefer Terser, set build.minify to "terser".`
      )
    );
  }

  const outputOption = config.build?.rollupOptions?.output ?? [];
  if (Array.isArray(outputOption)) {
    const assetFileNamesList = outputOption.map(
      (output) => output.assetFileNames
    );
    if (assetFileNamesList.length > 1) {
      const firstAssetFileNames = assetFileNamesList[0];
      const hasDifferentReference = assetFileNamesList.some(
        (assetFileNames) => assetFileNames !== firstAssetFileNames
      );
      if (hasDifferentReference) {
        resolved.logger.warn(
          colors.yellow(`
assetFileNames isn't equal for every build.rollupOptions.output. A single pattern across all outputs is supported by Vite.
`)
        );
      }
    }
  }

  return resolved;
}

export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config;
}
/**通过enforce对plugin进行分类，并按顺序进行排列。
 * Alias -> 带有 enforce: 'pre' 的用户插件
 * ->Vite 核心插件-> 没有 enforce 值的用户插件 ->
 * Vite 构建插件 ->带有 enforce: 'post' 的用户插件 -> Vite 后置构建插件
 */
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
      const pkg = lookupFile(configRoot, ["package.json"]);
      isESM =
        !!pkg && JSON.parse(fs.readFileSync(pkg, "utf-8")).type === "module";
    } catch (e) {
      console.log(e);
    }
  }

  try {
    const bundled = await bundleConfigFile(resolvedPath, isESM);
    const userConfig = await loadConfigFromBundledFile(
      resolvedPath,
      bundled.code,
      isESM
    );
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
    console.log(e);
    createLogger(logLevel).error(
      colors.red(`failed to load config from ${resolvedPath}`),
      { error: e }
    );
    throw e;
  }
}
/**打包成对应得cjs或者esm得文件 */
async function bundleConfigFile(
  fileName: string,
  isESM: boolean
): Promise<{ code: string; dependencies: string[] }> {
  const dirnameVarName = "__vite_injected_original_dirname";
  const filenameVarName = "__vite_injected_original_filename";
  const importMetaUrlVarName = "__vite_injected_original_import_meta_url";
  const result = await build({
    absWorkingDir: process.cwd(),
    entryPoints: [fileName],
    outfile: "out.js",
    write: false,
    target: ["node14.18", "node16"],
    platform: "node",
    bundle: true,
    format: isESM ? "esm" : "cjs",
    mainFields: ["main"],
    sourcemap: "inline",
    metafile: true,
    define: {
      __dirname: dirnameVarName,
      __filename: filenameVarName,
      "import.meta.url": importMetaUrlVarName,
    },
    plugins: [
      {
        name: "externalize-deps",
        setup(build) {
          const options: InternalResolveOptionsWithOverrideConditions = {
            root: path.dirname(fileName),
            isBuild: true,
            isProduction: true,
            preferRelative: false,
            tryIndex: true,
            mainFields: [],
            browserField: false,
            conditions: [],
            overrideConditions: ["node"],
            dedupe: [],
            extensions: DEFAULT_EXTENSIONS,
            preserveSymlinks: false,
            packageCache: new Map(),
          };

          // externalize bare imports
          build.onResolve(
            { filter: /^[^.].*/ },
            async ({ path: id, importer, kind }) => {
              if (
                kind === "entry-point" ||
                path.isAbsolute(id) ||
                isBuiltin(id)
              ) {
                return;
              }
              if (id.startsWith("npm:")) {
                return { external: true };
              }

              const isIdESM = isESM || kind === "dynamic-import";
              let idFsPath = tryNodeResolve(
                id,
                importer,
                { ...options, isRequire: !isIdESM },
                false
              )?.id;
              if (idFsPath && isIdESM) {
                // pathToFileURL 用来将文件路径转换成文件URL路径
                idFsPath = pathToFileURL(idFsPath).href;
              }
              return {
                path: idFsPath,
                external: true,
              };
            }
          );
        },
      },
      {
        name: "inject-file-scope-variables",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
            const contents = await fs.promises.readFile(args.path, "utf8");
            const injectValues =
              `const ${dirnameVarName} = ${JSON.stringify(
                path.dirname(args.path)
              )};` +
              `const ${filenameVarName} = ${JSON.stringify(args.path)};` +
              `const ${importMetaUrlVarName} = ${JSON.stringify(
                pathToFileURL(args.path).href
              )};`;

            return {
              loader: args.path.endsWith("ts") ? "ts" : "js",
              contents: injectValues + contents,
            };
          });
        },
      },
    ],
  });
  const { text } = result.outputFiles[0];
  return {
    code: text,
    dependencies: result.metafile ? Object.keys(result.metafile.inputs) : [],
  };
}

const _require = createRequire(import.meta.url);
async function loadConfigFromBundledFile(
  fileName: string,
  bundledCode: string,
  isESM: boolean
): Promise<UserConfigExport> {
  if (isESM) {
    const fileBase = `${fileName}.timestamp-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const fileNameTmp = `${fileBase}.mjs`;
    const fileUrl = `${pathToFileURL(fileBase)}.mjs`;
    await fsp.writeFile(fileNameTmp, bundledCode);
    try {
      return (await dynamicImport(fileUrl)).default;
    } finally {
      fs.unlink(fileNameTmp, () => {}); // Ignore errors
    }
  } else {
    const extension = path.extname(fileName);
    const realFileName = await promisifiedRealpath(fileName);
    const loaderExt = extension in _require.extensions ? extension : ".js";
    const defaultLoader = _require.extensions[loaderExt]!;
    _require.extensions[loaderExt] = (module: NodeModule, filename: string) => {
      if (filename === realFileName) {
        (module as NodeModuleWithCompile)._compile(bundledCode, filename);
      } else {
        defaultLoader(module, filename);
      }
    };
    delete _require.cache[_require.resolve(fileName)];
    const raw = _require(fileName);
    _require.extensions[loaderExt] = defaultLoader;
    return raw.__esModule ? raw.default : raw;
  }
}

export function getDepOptimizationConfig(
  config: ResolvedConfig,
  ssr: boolean
): DepOptimizationConfig {
  return config.optimizeDeps;
}

async function runConfigHook(
  config: InlineConfig,
  plugins: Plugin[],
  configEnv: ConfigEnv
): Promise<InlineConfig> {
  let conf = config;

  for (const p of getSortedPluginsByHook("config", plugins)) {
    const hook = p.config;
    const handler = hook && "handler" in hook ? hook.handler : hook;
    if (handler) {
      const res = await handler(conf, configEnv);
      if (res) {
        conf = mergeConfig(conf, res);
      }
    }
  }

  return conf;
}

export function isDepsOptimizerEnabled(
  config: ResolvedConfig,
  ssr: boolean
): boolean {
  const { command } = config;
  const { disabled } = getDepOptimizationConfig(config, ssr);
  return !(
    disabled === true ||
    (command === "build" && disabled === "build") ||
    (command === "serve" && disabled === "dev")
  );
}
