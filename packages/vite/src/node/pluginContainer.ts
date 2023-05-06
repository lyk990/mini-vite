import type { Plugin } from "vite";
import type {
  LoadResult,
  PartialResolvedId,
  SourceDescription,
  PluginContext as RollupPluginContext,
  ResolvedId,
  CustomPluginOptions,
  AsyncPluginHooks,
  ParallelPluginHooks,
  FunctionPluginHooks,
  InputOptions,
  ModuleInfo,
  MinimalPluginContext,
} from "rollup";
import { ModuleGraph } from "vite";
import { ResolvedConfig } from "./config";
import type { FSWatcher } from "chokidar";
import { createPluginHookUtils, resolvePlugins } from "./plugins";
import { join } from "path";
import { VERSION as rollupVersion } from "rollup";

type PluginContext = Omit<RollupPluginContext, "cache" | "moduleIds">;

export interface PluginContainer {
  options: InputOptions;
  getModuleInfo(id: string): ModuleInfo | null;
  buildStart(options: InputOptions): Promise<void>;
  resolveId(
    id: string,
    importer?: string,
    options?: {
      assertions?: Record<string, string>;
      custom?: CustomPluginOptions;
      skip?: Set<Plugin>;
      ssr?: boolean;
      /**
       * @internal
       */
      scan?: boolean;
      isEntry?: boolean;
    }
  ): Promise<PartialResolvedId | null>;
  transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription["map"];
      ssr?: boolean;
    }
  ): Promise<SourceDescription | null>;
  load(
    id: string,
    options?: {
      ssr?: boolean;
    }
  ): Promise<LoadResult | null>;
  close(): Promise<void>;
}

export async function createPluginContainer(
  config: ResolvedConfig,
  moduleGraph?: ModuleGraph,
  watcher?: FSWatcher
): Promise<PluginContainer> {
  const {
    plugins,
    logger,
    root,
    build: { rollupOptions },
  } = config;
  const { getSortedPluginHooks, getSortedPlugins } =
    createPluginHookUtils(plugins);

  const seenResolves: Record<string, true | undefined> = {};

  const watchFiles = new Set<string>();

  const minimalContext: MinimalPluginContext = {
    meta: {
      rollupVersion,
      watchMode: true,
    },
  };

  // parallel, ignores returns
  async function hookParallel<H extends AsyncPluginHooks & ParallelPluginHooks>(
    hookName: H,
    context: (plugin: Plugin) => ThisType<FunctionPluginHooks[H]>,
    args: (plugin: Plugin) => Parameters<FunctionPluginHooks[H]>
  ): Promise<void> {
    const parallelPromises: Promise<unknown>[] = [];
    for (const plugin of getSortedPlugins(hookName)) {
      const hook = plugin[hookName];
      if (!hook) continue;
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore hook is not a primitive
      const handler: Function = "handler" in hook ? hook.handler : hook;
      if ((hook as { sequential?: boolean }).sequential) {
        await Promise.all(parallelPromises);
        parallelPromises.length = 0;
        await handler.apply(context(plugin), args(plugin));
      } else {
        parallelPromises.push(handler.apply(context(plugin), args(plugin)));
      }
    }
    await Promise.all(parallelPromises);
  }

  const ModuleInfoProxy: ProxyHandler<ModuleInfo> = {
    get(info: any, key: string) {
      if (key in info) {
        return info[key];
      }
      if (key === "then") {
        return undefined;
      }
      throw Error(
        `[vite] The "${key}" property of ModuleInfo is not supported.`
      );
    },
  };

  const EMPTY_OBJECT = Object.freeze({});

  function getModuleInfo(id: string) {
    const module = moduleGraph?.getModuleById(id);
    if (!module) {
      return null;
    }
    if (!module.info) {
      module.info = new Proxy(
        { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
        ModuleInfoProxy
      );
    }
    return module.info;
  }

  function updateModuleInfo(id: string, { meta }: { meta?: object | null }) {
    if (meta) {
      const moduleInfo = getModuleInfo(id);
      if (moduleInfo) {
        moduleInfo.meta = { ...moduleInfo.meta, ...meta };
      }
    }
  }

  class Context implements PluginContext {
    meta = minimalContext.meta;
    ssr = false;
    _scan = false;
    _activePlugin: Plugin | null;
    _activeId: string | null = null;
    _activeCode: string | null = null;
    _resolveSkips?: Set<Plugin>;
    _addedImports: Set<string> | null = null;

    constructor(initialPlugin?: Plugin) {
      this._activePlugin = initialPlugin || null;
    }

    parse(code: string, opts: any = {}) {
      return parser.parse(code, {
        sourceType: "module",
        ecmaVersion: "latest",
        locations: true,
        ...opts,
      });
    }

    async resolve(
      id: string,
      importer?: string,
      options?: {
        assertions?: Record<string, string>;
        custom?: CustomPluginOptions;
        isEntry?: boolean;
        skipSelf?: boolean;
      }
    ) {
      let skip: Set<Plugin> | undefined;
      if (options?.skipSelf && this._activePlugin) {
        skip = new Set(this._resolveSkips);
        skip.add(this._activePlugin);
      }
      let out = await container.resolveId(id, importer, {
        assertions: options?.assertions,
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        skip,
        ssr: this.ssr,
        scan: this._scan,
      });
      if (typeof out === "string") out = { id: out };
      return out as ResolvedId | null;
    }

    async load(
      options: {
        id: string;
        resolveDependencies?: boolean;
      } & Partial<PartialNull<ModuleOptions>>
    ): Promise<ModuleInfo> {
      // We may not have added this to our module graph yet, so ensure it exists
      await moduleGraph?.ensureEntryFromUrl(options.id);
      updateModuleInfo(options.id, options);

      await container.load(options.id, { ssr: this.ssr });
      const moduleInfo = this.getModuleInfo(options.id);
      if (!moduleInfo)
        throw Error(`Failed to load module with id ${options.id}`);
      return moduleInfo;
    }

    getModuleInfo(id: string) {
      return getModuleInfo(id);
    }

    getModuleIds() {
      return moduleGraph
        ? moduleGraph.idToModuleMap.keys()
        : Array.prototype[Symbol.iterator]();
    }

    addWatchFile(id: string) {
      watchFiles.add(id);
      (this._addedImports || (this._addedImports = new Set())).add(id);
      if (watcher) ensureWatchedFile(watcher, id, root);
    }

    getWatchFiles() {
      return [...watchFiles];
    }

    warn(
      e: string | RollupError,
      position?: number | { column: number; line: number }
    ) {
      const err = formatError(e, position, this);
      const msg = buildErrorMessage(
        err,
        [colors.yellow(`warning: ${err.message}`)],
        false
      );
      logger.warn(msg, {
        clear: true,
        timestamp: true,
      });
    }

    error(
      e: string | RollupError,
      position?: number | { column: number; line: number }
    ): never {
      // error thrown here is caught by the transform middleware and passed on
      // the the error middleware.
      throw formatError(e, position, this);
    }
  }

  function formatError(
    e: string | RollupError,
    position: number | { column: number; line: number } | undefined,
    ctx: Context
  ) {
    const err = (
      typeof e === "string" ? new Error(e) : e
    ) as postcss.CssSyntaxError & RollupError;
    if (err.pluginCode) {
      return err; // The plugin likely called `this.error`
    }
    if (err.file && err.name === "CssSyntaxError") {
      err.id = normalizePath(err.file);
    }
    if (ctx._activePlugin) err.plugin = ctx._activePlugin.name;
    if (ctx._activeId && !err.id) err.id = ctx._activeId;
    if (ctx._activeCode) {
      err.pluginCode = ctx._activeCode;

      // some rollup plugins, e.g. json, sets err.position instead of err.pos
      const pos = position ?? err.pos ?? (err as any).position;

      if (pos != null) {
        let errLocation;
        try {
          errLocation = numberToPos(ctx._activeCode, pos);
        } catch (err2) {
          logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`
            ),
            // print extra newline to separate the two errors
            { error: err2 }
          );
          throw err;
        }
        err.loc = err.loc || {
          file: err.id,
          ...errLocation,
        };
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, pos);
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = ctx._activeCode;
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file);
            try {
              code = fs.readFileSync(err.loc.file, "utf-8");
            } catch {}
          }
          err.frame = generateCodeFrame(code, err.loc);
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column,
        };
        err.frame = err.frame || generateCodeFrame(err.id!, err.loc);
      }

      if (
        ctx instanceof TransformContext &&
        typeof err.loc?.line === "number" &&
        typeof err.loc?.column === "number"
      ) {
        const rawSourceMap = ctx._getCombinedSourcemap();
        if (rawSourceMap) {
          const traced = new TraceMap(rawSourceMap as any);
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column),
          });
          if (source && line != null && column != null) {
            err.loc = { file: source, line, column };
          }
        }
      }
    } else if (err.loc) {
      if (!err.frame) {
        let code = err.pluginCode;
        if (err.loc.file) {
          err.id = normalizePath(err.loc.file);
          if (!code) {
            try {
              code = fs.readFileSync(err.loc.file, "utf-8");
            } catch {}
          }
        }
        if (code) {
          err.frame = generateCodeFrame(code, err.loc);
        }
      }
    }

    if (
      typeof err.loc?.column !== "number" &&
      typeof err.loc?.line !== "number" &&
      !err.loc?.file
    ) {
      delete err.loc;
    }

    return err;
  }

  class TransformContext extends Context {
    filename: string;
    originalCode: string;
    originalSourcemap: SourceMap | null = null;
    sourcemapChain: NonNullable<SourceDescription["map"]>[] = [];
    combinedMap: SourceMap | null = null;

    constructor(filename: string, code: string, inMap?: SourceMap | string) {
      super();
      this.filename = filename;
      this.originalCode = code;
      if (inMap) {
        if (debugSourcemapCombine) {
          // @ts-expect-error inject name for debug purpose
          inMap.name = "$inMap";
        }
        this.sourcemapChain.push(inMap);
      }
    }

    _getCombinedSourcemap(createIfNull = false) {
      if (
        debugSourcemapCombine &&
        debugSourcemapCombineFilter &&
        this.filename.includes(debugSourcemapCombineFilter)
      ) {
        debugSourcemapCombine("----------", this.filename);
        debugSourcemapCombine(this.combinedMap);
        debugSourcemapCombine(this.sourcemapChain);
        debugSourcemapCombine("----------");
      }

      let combinedMap = this.combinedMap;
      for (let m of this.sourcemapChain) {
        if (typeof m === "string") m = JSON.parse(m);
        if (!("version" in (m as SourceMap))) {
          // empty, nullified source map
          combinedMap = this.combinedMap = null;
          this.sourcemapChain.length = 0;
          break;
        }
        if (!combinedMap) {
          combinedMap = m as SourceMap;
        } else {
          combinedMap = combineSourcemaps(cleanUrl(this.filename), [
            {
              ...(m as RawSourceMap),
              sourcesContent: combinedMap.sourcesContent,
            },
            combinedMap as RawSourceMap,
          ]) as SourceMap;
        }
      }
      if (!combinedMap) {
        return createIfNull
          ? new MagicString(this.originalCode).generateMap({
              includeContent: true,
              hires: true,
              source: cleanUrl(this.filename),
            })
          : null;
      }
      if (combinedMap !== this.combinedMap) {
        this.combinedMap = combinedMap;
        this.sourcemapChain.length = 0;
      }
      return this.combinedMap;
    }

    getCombinedSourcemap() {
      return this._getCombinedSourcemap(true) as SourceMap;
    }
  }

  let closed = false;

  const container: PluginContainer = {
    options: await (async () => {
      let options = rollupOptions;
      for (const optionsHook of getSortedPluginHooks("options")) {
        options = (await optionsHook.call(minimalContext, options)) || options;
      }
      if (options.acornInjectPlugins) {
        parser = acorn.Parser.extend(
          ...(arraify(options.acornInjectPlugins) as any)
        );
      }
      return {
        acorn,
        acornInjectPlugins: [],
        ...options,
      };
    })(),

    getModuleInfo,

    async buildStart() {
      await hookParallel(
        "buildStart",
        (plugin) => new Context(plugin),
        () => [container.options as NormalizedInputOptions]
      );
    },

    async resolveId(rawId, importer = join(root, "index.html"), options) {
      const skip = options?.skip;
      const ssr = options?.ssr;
      const scan = !!options?.scan;
      const ctx = new Context();
      ctx.ssr = !!ssr;
      ctx._scan = scan;
      ctx._resolveSkips = skip;
      const resolveStart = debugResolve ? performance.now() : 0;

      let id: string | null = null;
      const partial: Partial<PartialResolvedId> = {};
      for (const plugin of getSortedPlugins("resolveId")) {
        if (!plugin.resolveId) continue;
        if (skip?.has(plugin)) continue;

        ctx._activePlugin = plugin;

        const pluginResolveStart = debugPluginResolve ? performance.now() : 0;
        const handler =
          "handler" in plugin.resolveId
            ? plugin.resolveId.handler
            : plugin.resolveId;
        const result = await handler.call(ctx as any, rawId, importer, {
          assertions: options?.assertions ?? {},
          custom: options?.custom,
          isEntry: !!options?.isEntry,
          ssr,
          scan,
        });
        if (!result) continue;

        if (typeof result === "string") {
          id = result;
        } else {
          id = result.id;
          Object.assign(partial, result);
        }

        debugPluginResolve?.(
          timeFrom(pluginResolveStart),
          plugin.name,
          prettifyUrl(id, root)
        );

        // resolveId() is hookFirst - first non-null result is returned.
        break;
      }

      if (debugResolve && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
        const key = rawId + id;
        // avoid spamming
        if (!seenResolves[key]) {
          seenResolves[key] = true;
          debugResolve(
            `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
              id
            )}`
          );
        }
      }

      if (id) {
        partial.id = isExternalUrl(id) ? id : normalizePath(id);
        return partial as PartialResolvedId;
      } else {
        return null;
      }
    },

    async load(id, options) {
      const ssr = options?.ssr;
      const ctx = new Context();
      ctx.ssr = !!ssr;
      for (const plugin of getSortedPlugins("load")) {
        if (!plugin.load) continue;
        ctx._activePlugin = plugin;
        const handler =
          "handler" in plugin.load ? plugin.load.handler : plugin.load;
        const result = await handler.call(ctx as any, id, { ssr });
        if (result != null) {
          if (isObject(result)) {
            updateModuleInfo(id, result);
          }
          return result;
        }
      }
      return null;
    },

    async transform(code, id, options) {
      const inMap = options?.inMap;
      const ssr = options?.ssr;
      const ctx = new TransformContext(id, code, inMap as SourceMap);
      ctx.ssr = !!ssr;
      for (const plugin of getSortedPlugins("transform")) {
        if (!plugin.transform) continue;
        ctx._activePlugin = plugin;
        ctx._activeId = id;
        ctx._activeCode = code;
        const start = debugPluginTransform ? performance.now() : 0;
        let result: TransformResult | string | undefined;
        const handler =
          "handler" in plugin.transform
            ? plugin.transform.handler
            : plugin.transform;
        try {
          result = await handler.call(ctx as any, code, id, { ssr });
        } catch (e) {
          ctx.error(e);
        }
        if (!result) continue;
        debugPluginTransform?.(
          timeFrom(start),
          plugin.name,
          prettifyUrl(id, root)
        );
        if (isObject(result)) {
          if (result.code !== undefined) {
            code = result.code;
            if (result.map) {
              if (debugSourcemapCombine) {
                // @ts-expect-error inject plugin name for debug purpose
                result.map.name = plugin.name;
              }
              ctx.sourcemapChain.push(result.map);
            }
          }
          updateModuleInfo(id, result);
        } else {
          code = result;
        }
      }
      return {
        code,
        map: ctx._getCombinedSourcemap(),
      };
    },

    async close() {
      if (closed) return;
      const ctx = new Context();
      await hookParallel(
        "buildEnd",
        () => ctx,
        () => []
      );
      await hookParallel(
        "closeBundle",
        () => ctx,
        () => []
      );
      closed = true;
    },
  };

  return container;
}
