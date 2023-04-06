import connect from "connect";
import { blue, green } from "picocolors";
import { optimize } from "../optimizer/index";
import { resolvePlugins } from "../plugins";
import { createPluginContainer, PluginContainer } from "../pluginContainer";
import { Plugin } from "../plugin";

export interface ServerContext {
  root: string;
  pluginContainer: PluginContainer;
  app: connect.Server;
  plugins: Plugin[];
}

/** 创建server监听端口、解析vite配置、解析http配置、解析chokidar配置 */
export async function createServer() {
  const app = connect();
  const root = process.cwd();
  const startTime = Date.now();
  const plugins = await resolvePlugins();
  const pluginContainer = createPluginContainer(plugins);

  const serverContext: ServerContext = {
    root: process.cwd(),
    app,
    pluginContainer,
    plugins,
  };

  for (const plugin of plugins) {
    if (plugin.configureServer) {
      await plugin.configureServer(serverContext);
    }
  }
  app.listen(3003, async () => {
    await optimize(root);
    console.log(
      green("🚀 No-Bundle 服务已经成功启动!"),
      `耗时: ${Date.now() - startTime}ms`
    );
    console.log(`> 本地访问路径: ${blue("http://localhost:3003")}`);
  });
}
