import type {
  LoadResult,
  PartialResolvedId,
  SourceDescription,
  PluginContext as RollupPluginContext,
  ResolvedId,
  CustomPluginOptions,
  InputOptions,
  ModuleInfo,
  MinimalPluginContext,
  PartialNull,
  ModuleOptions,
  SourceMap,
  TransformResult,
  NormalizedInputOptions,
  ParallelPluginHooks,
  AsyncPluginHooks,
  FunctionPluginHooks,
} from "rollup";
import { ModuleGraph } from "vite";
import { ResolvedConfig } from "./config";
import { createPluginHookUtils } from "./plugins";
import { join } from "path";
import { VERSION as rollupVersion } from "rollup";
import { Plugin } from "./plugin";
import {
  createDebugger,
  isExternalUrl,
  isObject,
  normalizePath,
  prettifyUrl,
  timeFrom,
} from "./utils";
import * as acorn from "acorn";

type PluginContext = Omit<RollupPluginContext, "cache" | "moduleIds">;

const debugPluginResolve = createDebugger("vite:plugin-resolve", {
  onlyWhenFocused: "vite:plugin",
});

export let parser = acorn.Parser;

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
      scan?: boolean;
      isEntry?: boolean;
    }
  ): Promise<PartialResolvedId | null>;
  transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription["map"];
    }
  ): Promise<SourceDescription | null>;
  load(id: string, options?: {}): Promise<LoadResult | null>;
  close(): Promise<void>;
}
/**创建插件容器 */
export async function createPluginContainer(
  config: ResolvedConfig,
  moduleGraph?: ModuleGraph
): Promise<PluginContainer> {
  const {
    plugins,
    root,
    build: { rollupOptions },
  } = config;
  const { getSortedPlugins, getSortedPluginHooks } =
    createPluginHookUtils(plugins);

  const minimalContext: MinimalPluginContext = {
    meta: {
      rollupVersion,
      watchMode: true,
    },
  };

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
    _scan = false;
    _activePlugin: Plugin | null;
    _activeId: string | null = null;
    _activeCode: string | null = null;
    _resolveSkips?: Set<Plugin>;
    _addedImports: Set<string> | null = null;

    constructor(initialPlugin?: Plugin) {
      this._activePlugin = initialPlugin || null;
    }

    parse() {
      return {} as any;
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
      await moduleGraph?.ensureEntryFromUrl(options.id);
      updateModuleInfo(options.id, options);

      await container.load(options.id);
      const moduleInfo = this.getModuleInfo(options.id);
      if (!moduleInfo)
        throw Error(`Failed to load module with id ${options.id}`);
      return moduleInfo;
    }

    getModuleInfo(id: string) {
      return {} as any;
    }

    getModuleIds() {
      return {} as any;
    }

    addWatchFile() {
      return {} as any;
    }

    getWatchFiles() {
      return {} as any;
    }

    emitFile() {
      return "";
    }

    setAssetSource() {}

    getFileName() {
      return "";
    }
    warn() {}

    error() {
      return {} as never;
    }
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
        this.sourcemapChain.push(inMap);
      }
    }

    _getCombinedSourcemap(createIfNull = false) {
      let combinedMap = this.combinedMap;
      for (let m of this.sourcemapChain) {
        if (typeof m === "string") m = JSON.parse(m);
        if (!("version" in (m as SourceMap))) {
          combinedMap = this.combinedMap = null;
          this.sourcemapChain.length = 0;
          break;
        }
        if (!combinedMap) {
          combinedMap = m as SourceMap;
        }
      }
      if (!combinedMap) {
        return null;
      }
      if (combinedMap !== this.combinedMap) {
        this.combinedMap = combinedMap;
        this.sourcemapChain.length = 0;
      }
      return this.combinedMap;
    }
  }

  const container: PluginContainer = {
    options: await (async () => {
      let options = rollupOptions;
      for (const optionsHook of getSortedPluginHooks("options")) {
        options = (await optionsHook.call(minimalContext, options)) || options;
      }
      return {
        acorn,
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
      const scan = !!options?.scan;
      const ctx = new Context();
      ctx._scan = scan;
      ctx._resolveSkips = skip;

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

        break;
      }

      if (id) {
        partial.id = isExternalUrl(id) ? id : normalizePath(id);
        return partial as PartialResolvedId;
      } else {
        return null;
      }
    },

    async load(id) {
      const ctx = new Context();
      for (const plugin of getSortedPlugins("load")) {
        if (!plugin.load) continue;
        ctx._activePlugin = plugin;
        const handler =
          "handler" in plugin.load ? plugin.load.handler : plugin.load;
        const result = await handler.call(ctx as any, id);
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
      const ctx = new TransformContext(id, code, inMap as SourceMap);
      for (const plugin of getSortedPlugins("transform")) {
        if (!plugin.transform) continue;
        ctx._activePlugin = plugin;
        ctx._activeId = id;
        ctx._activeCode = code;
        let result: TransformResult | string | undefined;
        const handler =
          "handler" in plugin.transform
            ? plugin.transform.handler
            : plugin.transform;
        try {
          result = await handler.call(ctx as any, code, id);
        } catch (e) {}

        if (!result) continue;
        if (isObject(result)) {
          if (result.code !== undefined) {
            code = result.code;
            if (result.map) {
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

    async close() {},
  };

  return container;

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
}
