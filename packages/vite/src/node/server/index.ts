import connect from "connect";
import type { Connect } from "dep-types/connect";
// import { optimize } from "../optimizer/index";
import { resolvePlugins } from "../plugins";
import { createPluginContainer, PluginContainer } from "../pluginContainer";
import { Plugin } from "../plugin";
import { DEFAULT_DEV_PORT } from "../constants";
import {
  InlineConfig,
  ServerOptions,
  FileSystemServeOptions,
  ModuleGraph,
} from "vite";
import type * as http from "node:http";
import { httpServerStart, resolveHttpServer } from "../http";
import { resolveConfig } from "../config";
import { ResolvedConfig } from "../config";
import { resolveServerUrls } from "../utils";
import { printServerUrls } from "../logger";
import { initDepsOptimizer } from "../optimizer";
import { transformMiddleware } from "./middlewares/transform";
import { FSWatcher } from "chokidar";
import chokidar from "chokidar";

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
  moduleGraph: ModuleGraph;
  watcher: FSWatcher;
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
  //TODO 依赖预构建
  if (true) {
    await initDepsOptimizer(config);
  }
  const { root, server: serverConfig } = config;
  const middlewares = connect() as Connect.Server;
  const httpServer = await resolveHttpServer(middlewares);
  const plugins = await resolvePlugins();
  const container = await createPluginContainer(config);

  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr })
  );

  const watcher = chokidar.watch(root, {
    ignored: ["**/node_modules/**", "**/.git/**"],
    ignoreInitial: true,
  }) as FSWatcher;

  const server: ViteDevServer = {
    root,
    middlewares,
    httpServer,
    pluginContainer: container,
    plugins,
    config,
    moduleGraph,
    resolvedUrls: null,
    watcher,
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
  middlewares.use(transformMiddleware(server));
  // for (const plugin of plugins) {
  //   if (plugin.configureServer) {
  //     await plugin.configureServer(serverContext);
  //   }
  // }
  return server;
}
