import connect from "connect";
import { blue, green } from "picocolors";
import { optimize } from "../optimizer/index";

/** 创建server监听端口、解析vite配置、解析http配置、解析chokidar配置 */
export function createServer() {
  const app = connect();
  const root = process.cwd();
  const startTime = Date.now();
  app.listen(3003, async () => {
    await optimize(root);
    console.log(
      green("🚀 No-Bundle 服务已经成功启动!"),
      `耗时: ${Date.now() - startTime}ms`
    );
    console.log(`> 本地访问路径: ${blue("http://localhost:3003")}`);
  });
}
