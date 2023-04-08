import connect from "connect";
import type { Connect } from "dep-types/connect";
// import { optimize } from "../optimizer/index";
import { resolvePlugins } from "../plugins";
import { createPluginContainer } from "../pluginContainer";
import { Plugin } from "../plugin";
import { DEFAULT_DEV_PORT } from "../constants";
import type { PluginContainer, InlineConfig } from "vite";
import { createLogger } from "vite";
import type * as http from "node:http";
import { httpServerStart, resolveHttpServer } from "../http";
export interface ViteDevServer {
  root: string;
  middlewares: connect.Server;
  httpServer: http.Server | null;
  pluginContainer: PluginContainer;
  plugins: Plugin[];
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
    logger: createLogger("info", { allowClearScreen: true }),
  });
}

/** 创建server监听端口、解析vite配置、解析http配置、解析chokidar配置 */
export async function createServer(inlineConfig: InlineConfig = {}) {
  const middlewares = connect() as Connect.Server;
  const httpServer = inlineConfig.mode
    ? null
    : await resolveHttpServer(middlewares);
  const root = process.cwd();
  const plugins = await resolvePlugins();
  const container = createPluginContainer(plugins);

  const server: ViteDevServer = {
    root,
    middlewares,
    httpServer,
    pluginContainer: container,
    plugins,
  };

  // for (const plugin of plugins) {
  //   if (plugin.configureServer) {
  //     await plugin.configureServer(serverContext);
  //   }
  // }
  await startServer(server);
  return server;
}
