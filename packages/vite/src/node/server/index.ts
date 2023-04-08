import connect from "connect";
import type { Connect } from "dep-types/connect";
// import { optimize } from "../optimizer/index";
import { resolvePlugins } from "../plugins";
import { createPluginContainer } from "../pluginContainer";
import { Plugin } from "../plugin";
import { DEFAULT_DEV_PORT } from "../constants";
import type {
  PluginContainer,
  InlineConfig,
  ServerOptions,
  FileSystemServeOptions,
} from "vite";
import type * as http from "node:http";
import { httpServerStart, resolveHttpServer } from "../http";
import { resolveConfig } from "../config";
import { ResolvedConfig } from "../config";
import { resolveServerUrls } from "../utils";
import { printServerUrls } from "../logger";
export interface ResolvedServerUrls {
  local: string[];
  network: string[];
}
export interface ResolvedServerOptions extends ServerOptions {
  fs: Required<FileSystemServeOptions>;
  middlewareMode: boolean;
  // TODO
  sourcemapIgnoreList?: Exclude<
    ServerOptions["sourcemapIgnoreList"],
    false | undefined
  >;
}

export interface ViteDevServer {
  root: string;
  middlewares: connect.Server;
  httpServer: http.Server | null;
  pluginContainer: PluginContainer;
  plugins: Plugin[];
  config: ResolvedConfig;
  resolvedUrls: ResolvedServerUrls | null;
  printUrls(): void;
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>;
}

/**开启服务器,1、resolveHostname,2、 httpServerStart*/
async function startServer(server: ViteDevServer, inlinePort?: number) {
  const httpServer = server.httpServer;
  if (!httpServer) {
    throw new Error("Cannot call server.listen in middleware mode.");
  }
  const port = inlinePort ?? DEFAULT_DEV_PORT;
  // TODO 配置代理
  await httpServerStart(httpServer, {
    port,
    strictPort: false,
    host: "localhost",
    logger: server.config.logger,
  });
}

/** 创建server监听端口、解析vite配置、解析http配置、解析chokidar配置 */
export async function createServer(inlineConfig: InlineConfig = {}) {
  const config = await resolveConfig(inlineConfig, "serve");
  const { root, server: serverConfig } = config
  const middlewares = connect() as Connect.Server;
  const httpServer = await resolveHttpServer(middlewares);
  const plugins = await resolvePlugins();
  const container = createPluginContainer(plugins);

  const server: ViteDevServer = {
    root,
    middlewares,
    httpServer,
    pluginContainer: container,
    plugins,
    config,
    resolvedUrls: null,
    async listen(port?: number, isRestart?: boolean) {
      await startServer(server, port);
      if (httpServer) {
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config
        );
      }
      return server;
    },
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info
        );
      }
    },
  };

  // for (const plugin of plugins) {
  //   if (plugin.configureServer) {
  //     await plugin.configureServer(serverContext);
  //   }
  // }
  return server;
}
