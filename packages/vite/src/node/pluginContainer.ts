import type { Plugin } from "vite";
import type {
  LoadResult,
  PartialResolvedId,
  SourceDescription,
  PluginContext as RollupPluginContext,
  ResolvedId,
  CustomPluginOptions,
} from "rollup";
import { ModuleGraph } from "vite";
import { ResolvedConfig } from "./config";
import type { FSWatcher } from "chokidar";
import { resolvePlugins } from "./plugins";
import { join } from "path";

export interface PluginContainer {
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
  load(id: string): Promise<LoadResult | null>;
  transform(code: string, id: string): Promise<SourceDescription | null>;
}

export async function createPluginContainer(
  config: ResolvedConfig,
  moduleGraph?: ModuleGraph,
  watcher?: FSWatcher
): Promise<PluginContainer> {
  const {
    logger,
    root,
    build: { rollupOptions },
  } = config;
  // TODO
  const plugins = resolvePlugins();
  // @ts-ignore 这里仅实现上下文对象的 resolve 方法
  class Context implements RollupPluginContext {
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
      let skip: Set<Plugin> | undefined
      let out = await container.resolveId(id, importer, {
        assertions: options?.assertions,
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        skip,
        ssr: false,
        scan: false,
      });
      if (typeof out === "string") out = { id: out };
      return out as ResolvedId | null;
    }
  }
  const container: PluginContainer = {
    async resolveId(id: string, importer = join(root, "index.html"), options) {
      const ctx = new Context() as any;
      for (const plugin of plugins) { 
        // 判断插件是否有resolveId属性
        if (plugin.resolveId) {
          const newId = await plugin.resolveId.call(ctx as any, id, importer);
          if (newId) {
            id = typeof newId === "string" ? newId : newId.id;
            return { id };
          }
        }
      }
      return null;
    },
    async load(id: string) {
      const ctx = new Context() as any;
      for (const plugin of plugins) {
        if (plugin.load) {
          const result = await plugin.load.call(ctx, id);
          if (result) {
            return result;
          }
        }
      }
      return null;
    },
    async transform(code: string, id: string) {
      const ctx = new Context() as any;
      for (const plugin of plugins) {
        if (plugin.transform) {
          const result = await plugin.transform.call(ctx, code, id);
          if (!result) continue;
          if (typeof result === "string") {
            code = result;
          } else if (result.code) {
            code = result.code;
          }
        }
      }
      return { code };
    },
  };

  return container;
}
