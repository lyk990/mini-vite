import type { PluginHooks } from "rollup";

export interface Alias {
  find: string | RegExp;
  replacement: string;
  /**
   * Instructs the plugin to use an alternative resolving algorithm,
   * rather than the Rollup's resolver.
   * @default null
   */
  customResolver?: ResolverFunction | ResolverObject | null;
}

export type ResolverFunction = MapToFunction<PluginHooks["resolveId"]>;
export type MapToFunction<T> = T extends Function ? T : never;

export interface ResolverObject {
  buildStart?: PluginHooks["buildStart"];
  resolveId: ResolverFunction;
}
