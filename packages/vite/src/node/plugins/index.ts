import { HookHandler } from "vite";
import { ResolvedConfig, PluginHookUtils } from "../config";
import { watchPackageDataPlugin } from "../package";
import { Plugin } from "../plugin";
import { clientInjectionsPlugin } from "./clientInjections";
import { cssPlugin, cssPostPlugin } from "./css";
import { importAnalysisPlugin } from "./importAnalysis";
import { resolvePlugin } from "./resolve";
import { getDepsOptimizer } from "../optimizer/optimizer";
import { esbuildPlugin } from "./esbuild";
import { assetPlugin } from "./asset";
import { htmlInlineProxyPlugin } from "./html";
// import { preAliasPlugin } from "./preAlias"; // DELETE
import aliasPlugin from "@rollup/plugin-alias";

export async function resolvePlugins(
  config: ResolvedConfig,
  prePlugins: Plugin[],
  normalPlugins: Plugin[],
  postPlugins: Plugin[]
): Promise<Plugin[]> {
  const isBuild = config.command === "build";
  // const buildPlugins = { pre: [], post: [] }; // DELETE

  return [
    watchPackageDataPlugin(config.packageCache),
    // preAliasPlugin(config), // DELETE
    aliasPlugin({ entries: config.resolve.alias }),
    ...prePlugins,
    resolvePlugin({
      ...config.resolve,
      root: config.root,
      isProduction: config.isProduction,
      isBuild,
      packageCache: config.packageCache,
      // ssrConfig: config.ssr, // DELETE
      asSrc: true,
      getDepsOptimizer: (ssr: boolean) => getDepsOptimizer(config, ssr),
      shouldExternalize: undefined,
    }),
    htmlInlineProxyPlugin(config),
    cssPlugin(config),
    config.esbuild !== false ? esbuildPlugin(config) : null,
    assetPlugin(config),
    ...normalPlugins,
    cssPostPlugin(config),
    // ...buildPlugins.pre, DELETE
    ...postPlugins,
    // ...buildPlugins.post,DELETE
    clientInjectionsPlugin(config),
    importAnalysisPlugin(config),
  ].filter(Boolean) as Plugin[]; // NOTE Bolean 写法
}

export function createPluginHookUtils(
  plugins: readonly Plugin[]
): PluginHookUtils {
  const sortedPluginsCache = new Map<keyof Plugin, Plugin[]>();
  function getSortedPlugins(hookName: keyof Plugin): Plugin[] {
    if (sortedPluginsCache.has(hookName))
      return sortedPluginsCache.get(hookName)!;
    const sorted = getSortedPluginsByHook(hookName, plugins);
    sortedPluginsCache.set(hookName, sorted);
    return sorted;
  }
  function getSortedPluginHooks<K extends keyof Plugin>(
    hookName: K
  ): NonNullable<HookHandler<Plugin[K]>>[] {
    const plugins = getSortedPlugins(hookName);
    return plugins
      .map((p) => {
        const hook: any = p[hookName]!;
        return typeof hook === "object" && "handler" in hook
          ? hook.handler
          : hook;
      })
      .filter(Boolean);
  }

  return {
    getSortedPlugins,
    getSortedPluginHooks,
  };
}

export function getSortedPluginsByHook(
  hookName: keyof Plugin,
  plugins: readonly Plugin[]
): Plugin[] {
  const pre: Plugin[] = [];
  const normal: Plugin[] = [];
  const post: Plugin[] = [];
  for (const plugin of plugins) {
    const hook = plugin[hookName];
    if (hook) {
      if (typeof hook === "object") {
        if (hook.order === "pre") {
          pre.push(plugin);
          continue;
        }
        if (hook.order === "post") {
          post.push(plugin);
          continue;
        }
      }
      normal.push(plugin);
    }
  }
  return [...pre, ...normal, ...post];
}
