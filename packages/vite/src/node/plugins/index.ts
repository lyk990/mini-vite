import { HookHandler } from "vite";
import { ResolvedConfig, PluginHookUtils } from "../config";
// import { watchPackageDataPlugin } from "../package";
import { Plugin } from "../plugin";
// import { clientInjectionsPlugin } from "./clientInjections";
import { cssPlugin } from "./css";
import { importAnalysisPlugin } from "./importAnalysis";
import { resolvePlugin } from "./resolve";

export function resolvePlugins(
  config?: ResolvedConfig,
  prePlugins?: Plugin[],
  normalPlugins?: Plugin[],
  postPlugins?: Plugin[]
): Plugin[] {
  return [
    resolvePlugin(),
    // esbuildPlugin(),
    importAnalysisPlugin(),
    cssPlugin(),
    // watchPackageDataPlugin()
    // assetPlugin(),
    // clientInjectionsPlugin(config),
  ];
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
    // @ts-ignore
    return plugins
      .map((p) => {
        const hook = p[hookName]!;
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
