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

import { ResolvedServerOptions, resolveServerOptions } from "./server";
import {
  asyncFlatten,
  createDebugger,
  isBuiltin,
  isObject,
  lookupFile,
  normalizePath,
} from "./utils";
import fs from "node:fs";
import { build } from "esbuild";
import { InternalResolveOptionsWithOverrideConditions } from "./plugins/resolve";
import colors from "picocolors";
import { pathToFileURL } from "node:url";
import { findNearestPackageData, PackageCache } from "./packages";

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
      alias: Alias[]; // REMOVE
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
    publicDir?: string | false;
    command: "build" | "serve";
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
  let mode = "development";
  const configEnv = {
    mode,
    command,
    // ssrBuild: !!config.build?.ssr,
    ssrBuild: false,
  };
  const packageCache: PackageCache = new Map();
  
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
      // config = {
      //   define: { _VUE_OPTIONS_API: true },
      //   optimizeDeps: { force: undefined },
      //   plugins: ["vite-plugin-vue"],
      //   resolve: { dedupe: ["vue"] },
      //   server: {},
      //   ssr: { external: [] },
      // };
      // 合并vite.config.ts中的配置（plugins、alias、noExternal等）
      config = mergeConfig(loadResult.config, config);
      configFile = loadResult.path;
      configFileDependencies = loadResult.dependencies;
    }
  }
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
  // rawUserPlugins = [vite-plugin-vue]
  const rawUserPlugins = (
    (await asyncFlatten(config.plugins || [])) as Plugin[]
  ).filter(filterPlugin);
  //prePlugins = [], normalPlugins = 'vite-plugin-vue', postPlugins = []
  const [prePlugins, normalPlugins, postPlugins] =
    sortUserPlugins(rawUserPlugins);
  const userPlugins = [...prePlugins, ...normalPlugins, ...postPlugins];
  const logger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  });
  const resolvedRoot = normalizePath(
    config.root ? path.resolve(config.root) : process.cwd()
  );
  // 从cli.ts文件中传入的参数,默认为
  // config.optimizeDeps = {force: undefined}
  const optimizeDeps = config.optimizeDeps || {};
  const resolveOptions: ResolvedConfig["resolve"] = {
    mainFields: config.resolve?.mainFields ?? DEFAULT_MAIN_FIELDS, // = undefined
    browserField: config.resolve?.browserField ?? true, // = undefined
    conditions: config.resolve?.conditions ?? [], // = undefined
    extensions: config.resolve?.extensions ?? DEFAULT_EXTENSIONS, // = undefined
    dedupe: config.resolve?.dedupe ?? [], // ['vue']
    preserveSymlinks: config.resolve?.preserveSymlinks ?? false, // = undefined
    alias: [{ find: "", replacement: "@" }], // REMOVE clientAlias resolvedAlias
  };
  const resolvedBuildOptions = resolveBuildOptions(
    config.build,
    logger,
    resolvedRoot
  );

  const middlewareMode = config?.server?.middlewareMode;

  const isBuild = command === "build";
  const relativeBaseShortcut = config.base === "" || config.base === "./";

  const resolvedBase = relativeBaseShortcut
    ? true || config.build?.ssr
      ? "/"
      : "./"
    : resolveBaseUrl(config.base, isBuild, logger) ?? "/";
  const BASE_URL = resolvedBase;
  const server = resolveServerOptions(resolvedRoot, config.server, logger);
  const pkgDir = findNearestPackageData(resolvedRoot, packageCache)?.dir;
  
  const cacheDir = normalizePath(
    config.cacheDir
      ? path.resolve(resolvedRoot, config.cacheDir)
      : pkgDir
      ? path.join(pkgDir, `node_modules/.vite`)
      : path.join(resolvedRoot, `.vite`)
  );
  const resolvedConfig: ResolvedConfig = {
    configFile: configFile ? normalizePath(configFile) : undefined,
    configFileDependencies: configFileDependencies.map((name) =>
      normalizePath(path.resolve(name))
    ),
    inlineConfig,
    logger,
    cacheDir,
    command,
    root: process.cwd(),
    base: resolvedBase.endsWith("/") ? resolvedBase : resolvedBase + "/",
    env: {
      BASE_URL,
      MODE: mode,
      DEV: true,
      PROD: false,
    },
    server,
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

// export function getDepOptimizationConfig(
//   config: ResolvedConfig,
//   ssr: boolean
// ): DepOptimizationConfig {
//   return ssr ? config?.ssr.optimizeDeps : config.optimizeDeps;
// }

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
    // budled =
    // code: '// vite.config.ts\nimport { defineConfig } from "file:///C:/Users/Administrator/Desktop/learn-Code/vite%E6%BA%90%E7%A0%81/mini-vite/node_modules/.pnpm/vite@4.2.1_@types+node@18.15.11/node_modules/vite/dist/node/index.js";\nimport vue from "file:///C:/Users/Administrator/Desktop/learn-Code/vite%E6%BA%90%E7%A0%81/mini-vite/node_modules/.pnpm/@vitejs+plugin-vue@4.1.0_vite@4.2.1_vue@3.2.47/node_modules/@vitejs/plugin-vue/dist/index.mjs";\nvar vite_config_default = defineConfig({\n  plugins: [vue()]\n});…lRTYlQkElOTAlRTclQTAlODEvbWluaS12aXRlL21pbmktdml0ZS1leGFtcGxlL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcInZpdGVcIjtcbmltcG9ydCB2dWUgZnJvbSBcIkB2aXRlanMvcGx1Z2luLXZ1ZVwiO1xuXG4vLyBodHRwczovL3ZpdGVqcy5kZXYvY29uZmlnL1xuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgcGx1Z2luczogW3Z1ZSgpXSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFzYixTQUFTLG9CQUFvQjtBQUNuZCxPQUFPLFNBQVM7QUFHaEIsSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDMUIsU0FBUyxDQUFDLElBQUksQ0FBQztBQUNqQixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=\n'
    // dependencies: (1) ['vite.config.ts']
    const bundled = await bundleConfigFile(resolvedPath, isESM);
    // userConfig = { plugins: [ vite-plugin-vue ] }
    const userConfig = await loadConfigFromBundledFile(
      resolvedPath,
      bundled.code,
      isESM
    );
    const config = await (typeof userConfig === "function"
      ? userConfig(configEnv)
      : userConfig);
    // config = { plugins: [ vite-plugin-vue, ] }
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

              // partial deno support as `npm:` does not work with esbuild
              if (id.startsWith("npm:")) {
                return { external: true };
              }

              const isIdESM = isESM || kind === "dynamic-import";
              // TODO
              // let idFsPath = tryNodeResolve(
              //   id,
              //   importer,
              //   { ...options, isRequire: !isIdESM },
              //   false
              // )?.id;
              let idFsPath =
                "C:/Users/Administrator/Desktop/learn-Code/vite源码/mini-vite/node_modules/.pnpm/vite@4.2.1_@types+node@18.15.11/node_modules/vite/dist/node/index.js";
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

// TODO
async function loadConfigFromBundledFile(
  fileName: string,
  bundledCode: string,
  isESM: boolean
): Promise<UserConfigExport> {
  // if (isESM) {
  //   const fileBase = `${fileName}.timestamp-${Date.now()}-${Math.random()
  //     .toString(16)
  //     .slice(2)}`
  //   const fileNameTmp = `${fileBase}.mjs`
  //   const fileUrl = `${pathToFileURL(fileBase)}.mjs`
  //   await fsp.writeFile(fileNameTmp, bundledCode)
  //   try {
  //     return (await dynamicImport(fileUrl)).default
  //   } finally {
  //     fs.unlink(fileNameTmp, () => {}) // Ignore errors
  //   }
  // }
  // else {
  //   const extension = path.extname(fileName)
  //   const realFileName = await promisifiedRealpath(fileName)
  //   const loaderExt = extension in _require.extensions ? extension : '.js'
  //   const defaultLoader = _require.extensions[loaderExt]!
  //   _require.extensions[loaderExt] = (module: NodeModule, filename: string) => {
  //     if (filename === realFileName) {
  //       ;(module as NodeModuleWithCompile)._compile(bundledCode, filename)
  //     } else {
  //       defaultLoader(module, filename)
  //     }
  //   }
  //   // clear cache in case of server restart
  //   delete _require.cache[_require.resolve(fileName)]
  //   const raw = _require(fileName)
  //   _require.extensions[loaderExt] = defaultLoader
  //   return raw.__esModule ? raw.default : raw
  // }
  return {} as any;
}

export function getDepOptimizationConfig(
  config: ResolvedConfig,
  ssr: boolean
): DepOptimizationConfig {
  return config.optimizeDeps;
}
