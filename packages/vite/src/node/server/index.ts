import connect from "connect";
import type { Connect } from "dep-types/connect";
import { blue, green } from "picocolors";
// import { optimize } from "../optimizer/index";
import { resolvePlugins } from "../plugins";
import { createPluginContainer } from "../pluginContainer";
import { Plugin } from "../plugin";
import { PluginContainer, InlineConfig } from "vite";
import { DEFAULT_DEV_PORT } from "../constants";

export interface ViteDevServer {
  root: string;
  httpServer: connect.Server;
  pluginContainer: PluginContainer;
  plugins: Plugin[];
}

/**开启服务器,1、resolveHostname,2、 httpServerStart*/
async function startServer(server: ViteDevServer, inlinePort?: number) {
  const httpServer = server.httpServer;
  const startTime = Date.now();
  const port = inlinePort ?? DEFAULT_DEV_PORT;
  return new Promise((resolve, reject) => {
    const onError = () => {};

    httpServer.on("error", onError);
    httpServer.listen(port, async () => {
      // await optimize(root);
      console.log(
        green("🚀 mini-vite 服务已经成功启动!"),
        `耗时: ${Date.now() - startTime}ms`
      );
      console.log(`> 本地访问路径: ${blue("http://localhost:3003")}`);
      resolve(port);
    });
  });
}

/** 创建server监听端口、解析vite配置、解析http配置、解析chokidar配置 */
export async function createServer(inlineConfig: InlineConfig = {}) {
  const middlewares = connect() as Connect.Server;
  // TODO 
  const httpServer = inlineConfig.mode ? null : "";
  const root = process.cwd();
  const plugins = await resolvePlugins();
  const container = createPluginContainer(plugins);

  const server: ViteDevServer = {
    root,
    middlewares,
    pluginContainer: container,
    plugins,
  };

  // for (const plugin of plugins) {
  //   if (plugin.configureServer) {
  //     await plugin.configureServer(serverContext);
  //   }
  // }
  await startServer(server);
}
