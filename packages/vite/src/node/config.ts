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
import { ResolvedServerOptions, resolveServerOptions } from "./server";
import {
  asyncFlatten,
  createDebugger,
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
import { resolvePlugin, tryNodeResolve } from "./plugins/resolve";
import {
  createPluginHookUtils,
  getSortedPluginsByHook,
  resolvePlugins,
} from "./plugins";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import type { OutgoingHttpHeaders as HttpServerHeaders } from "node:http";

const debug = createDebugger("vite:config");

export type CorsOrigin = boolean | string | RegExp | (string | RegExp)[];

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
  cors?: CorsOptions | boolean;
  headers?: HttpServerHeaders;
}

export type ResolveFn = (
  id: string,
  importer?: string,
  aliasOnly?: boolean
) => Promise<string | undefined>;

export interface ResolveOptions {
  mainFields?: string[];
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
    plugins: readonly Plugin[];
    define?: Record<string, any>;
    env: Record<string, any>;
    base: string;
    publicDir: string;
    command: "build" | "serve";
    createResolver: (options?: Partial<InternalResolveOptions>) => ResolveFn;
    assetsInclude: (file: string) => boolean;
    packageCache: PackageCache;
    envDir: string;
    experimental: ExperimentalOptions;
    mode: string;
    esbuild: ESBuildOptions | false;
    rawBase: string;
  } & PluginHookUtils
>;

export interface PluginHookUtils {
  getSortedPlugins: (hookName: keyof Plugin) => Plugin[];
  getSortedPluginHooks: <K extends keyof Plugin>(
    hookName: K
  ) => NonNullable<HookHandler<Plugin[K]>>[];
}
/**解析所有配置 */
export async function resolveConfig(
  inlineConfig: InlineConfig,
  command: "build" | "serve",
  defaultMode = "development",
  defaultNodeEnv = "development"
): Promise<ResolvedConfig> {
  let config = inlineConfig;
  let configFileDependencies: string[] = [];
  let mode = inlineConfig.mode || defaultMode;
  const packageCache: PackageCache = new Map();

  process.env.NODE_ENV = defaultNodeEnv;
  const configEnv = {
    mode,
    command,
  };

  let { configFile } = config;
  if (configFile !== false) {
    // configFile为undefined，所以会进到这个if语句
    const loadResult = await loadConfigFromFile(
      configEnv,
      config.root,
      config.logLevel
    );
    if (loadResult) {
      config = mergeConfig(loadResult.config, config);
      configFile = loadResult.path;
      configFileDependencies = loadResult.dependencies;
    }
  }

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

  const rawUserPlugins = (
    (await asyncFlatten(config.plugins || [])) as Plugin[]
  ).filter(filterPlugin);

  const [prePlugins, normalPlugins, postPlugins] =
    sortUserPlugins(rawUserPlugins);

  const userPlugins = [...prePlugins, ...normalPlugins, ...postPlugins];
  config = await runConfigHook(config, userPlugins, configEnv);
  const logger = createLogger(config.logLevel, {
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
    mainFields: DEFAULT_MAIN_FIELDS,
    conditions: [],
    extensions: DEFAULT_EXTENSIONS,
    dedupe: [],
    preserveSymlinks: false,
    alias: resolvedAlias,
  };

  const envDir = resolvedRoot;
  const isProduction = false;

  const isBuild = command === "build";
  const relativeBaseShortcut = config.base === "" || config.base === "./";

  const resolvedBase = relativeBaseShortcut
    ? !isBuild
      ? "/"
      : "./"
    : resolveBaseUrl(config.base, isBuild, logger) ?? "/";

  const resolvedBuildOptions = resolveBuildOptions(config.build);

  const pkgDir = findNearestPackageData(resolvedRoot, packageCache)?.dir;
  const cacheDir = normalizePath(
    config.cacheDir
      ? path.resolve(resolvedRoot, config.cacheDir)
      : pkgDir
      ? path.join(pkgDir, `node_modules/.vite`)
      : path.join(resolvedRoot, `.vite`)
  );

  const createResolver: ResolvedConfig["createResolver"] = (options) => {
    let aliasContainer: PluginContainer | undefined;
    let resolverContainer: PluginContainer | undefined;
    return async (id, importer, aliasOnly) => {
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
                asSrc: true,
                preferRelative: false,
                tryIndex: true,
                ...options,
                idOnly: true,
              } as any),
            ],
          }));
      }
      return (
        await container.resolveId(id, importer, {
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

  const server = resolveServerOptions(resolvedRoot, config.server);
  const optimizeDeps = config.optimizeDeps || {};
  const BASE_URL = resolvedBase;

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
      BASE_URL,
      MODE: mode,
      DEV: !isProduction,
      PROD: isProduction,
    },
    assetsInclude(file: string) {
      return DEFAULT_ASSETS_RE.test(file);
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
    appType: "spa",
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
  return resolved;
}

/**通过enforce对plugin进行分类，并按顺序进行排列。
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

/**获取vite.config.ts配置文件中的内容 */
export async function loadConfigFromFile(
  configEnv: ConfigEnv,
  configRoot: string = process.cwd(),
  logLevel?: LogLevel
): Promise<{
  path: string;
  config: UserConfig;
  dependencies: string[];
} | null> {
  let resolvedPath: string | undefined;
  // 没有配置文件，就遍历默认配置文件 DEFAULT_CONFIG_FILES  'vite.config.js',
  for (const filename of DEFAULT_CONFIG_FILES) {
    const filePath = path.resolve(configRoot, filename);
    //fs.existsSync() 用于检测文件是否存在，返回布尔值类型
    if (!fs.existsSync(filePath)) continue;
    resolvedPath = filePath;
    break;
  }
  if (!resolvedPath) {
    debug?.("no config file found.");
    return null;
  }
  let isESM = false;
  try {
    const pkg = lookupFile(configRoot, ["package.json"]);
    // 读取package.json文件，判断是否为esm模块
    isESM =
      !!pkg && JSON.parse(fs.readFileSync(pkg, "utf-8")).type === "module";
  } catch (e) {}

  try {
    const bundled = await bundleConfigFile(resolvedPath, isESM);
    const userConfig = await loadConfigFromBundledFile(
      resolvedPath,
      bundled.code
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
    createLogger(logLevel).error(
      colors.red(`failed to load config from ${resolvedPath}`),
      { error: e }
    );
    throw e;
  }
}
/**打包成对应得cjs或者esm文件 */
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
    format: "esm",
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
            preferRelative: false,
            tryIndex: true,
            mainFields: [],
            conditions: [],
            overrideConditions: ["node"],
            dedupe: [],
            extensions: DEFAULT_EXTENSIONS,
            preserveSymlinks: false,
            packageCache: new Map(),
          };

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
/**从打包后的文件加载配置信息 */
async function loadConfigFromBundledFile(
  fileName: string,
  bundledCode: string
): Promise<UserConfigExport> {
  const fileBase = `${fileName}.timestamp-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const fileNameTmp = `${fileBase}.mjs`;
  const fileUrl = `${pathToFileURL(fileBase)}.mjs`;
  await fsp.writeFile(fileNameTmp, bundledCode);
  try {
    return (await dynamicImport(fileUrl)).default;
  } finally {
    fs.unlink(fileNameTmp, () => {});
  }
}
/**获取optimizeDeps依赖预构建的配置项 */
export function getDepOptimizationConfig(
  config: ResolvedConfig
): DepOptimizationConfig {
  return config.optimizeDeps;
}
/**执行vite.config.ts中的钩子函数 */
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
