import type {
  ConfigEnv,
  HmrContext,
  IndexHtmlTransform,
  ModuleNode,
  PreviewServerHook,
  UserConfig,
} from "vite";
import { ViteDevServer } from "./server";
import type {
  CustomPluginOptions,
  LoadResult,
  ObjectHook,
  PluginContext,
  ResolveIdResult,
  Plugin as RollupPlugin,
  TransformPluginContext,
  TransformResult,
} from "rollup";
import { ResolvedConfig } from "./config";
export type ServerHook = (
  server: ViteDevServer
) => (() => void) | void | Promise<(() => void) | void>;

// 只实现以下这几个钩子
// export interface Plugin {
//   name: string;
//   configureServer?: ServerHook;
//   resolveId?: (
//     id: string,
//     importer?: string
//   ) => Promise<PartialResolvedId | null> | PartialResolvedId | null;
//   load?: (id: string) => Promise<LoadResult | null> | LoadResult | null;
//   transform?: (
//     code: string,
//     id: string
//   ) => Promise<SourceDescription | null> | SourceDescription | null;
//   // transformIndexHtml?: (raw: string) => Promise<string> | string;
//   transformIndexHtml?: IndexHtmlTransform;
//   enforce?: "pre" | "post";
//   apply?:
//     | "serve"
//     | "build"
//     | ((this: void, config: UserConfig, env: ConfigEnv) => boolean);
//   handleHotUpdate?: ObjectHook<
//     (
//       this: void,
//       ctx: HmrContext
//     ) => Array<ModuleNode> | void | Promise<Array<ModuleNode> | void>
//   >;
// }

export interface Plugin extends RollupPlugin {
  enforce?: "pre" | "post";
  apply?:
    | "serve"
    | "build"
    | ((this: void, config: UserConfig, env: ConfigEnv) => boolean);
  config?: ObjectHook<
    (
      this: void,
      config: UserConfig,
      env: ConfigEnv
    ) => UserConfig | null | void | Promise<UserConfig | null | void>
  >;

  configResolved?: ObjectHook<
    (this: void, config: ResolvedConfig) => void | Promise<void>
  >;
  configureServer?: ObjectHook<ServerHook>;
  configurePreviewServer?: ObjectHook<PreviewServerHook>;
  transformIndexHtml?: IndexHtmlTransform;
  handleHotUpdate?: ObjectHook<
    (
      this: void,
      ctx: HmrContext
    ) => Array<ModuleNode> | void | Promise<Array<ModuleNode> | void>
  >;
  resolveId?: ObjectHook<
    (
      this: PluginContext,
      source: string,
      importer: string | undefined,
      options: {
        assertions: Record<string, string>;
        custom?: CustomPluginOptions;
        ssr?: boolean;
        /**
         * @internal
         */
        scan?: boolean;
        isEntry: boolean;
      }
    ) => Promise<ResolveIdResult> | ResolveIdResult
  >;
  load?: ObjectHook<
    (
      this: PluginContext,
      id: string,
      options?: { ssr?: boolean }
    ) => Promise<LoadResult> | LoadResult
  >;
  transform?: ObjectHook<
    (
      this: TransformPluginContext,
      code: string,
      id: string,
      options?: { ssr?: boolean }
    ) => Promise<TransformResult> | TransformResult
  >;
}
