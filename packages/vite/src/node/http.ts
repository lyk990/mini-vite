import type { Logger } from "./logger";
import type { Server as HttpServer } from "node:http";
import type { Connect } from "dep-types/connect";
import { blue } from "picocolors";

export async function resolveHttpServer(app: Connect.Server) {
  const { createServer } = await import("node:http");
  return createServer(app);
}

export async function httpServerStart(
  httpServer: HttpServer,
  serverOptions: {
    port: number;
    strictPort: boolean | undefined;
    host: string | undefined;
    logger: Logger;
  }
): Promise<number> {
  let { port, strictPort, host, logger } = serverOptions;
  return new Promise((resolve, reject) => {
    // 创建http服务器报错时
    const onError = (e: Error & { code?: string }) => {
      if (e.code === "EADDRINUSE") {
        if (strictPort) {
          httpServer.removeListener("error", onError);
          reject(new Error(`Port ${port} is already in use`));
        } else {
          logger.info(`Port ${port} is in use, trying another one...`);
          httpServer.listen(++port, host);
        }
      } else {
        httpServer.removeListener("error", onError);
        reject(e);
      }
    };
    httpServer.on("error", onError);
    // 监听端口
    httpServer.listen(port, async () => {
      // TODO vite启动耗时
      // console.log(
      //   green("🚀 mini-vite 服务已经成功启动!"),
      //   `耗时: ${Date.now() - startTime}ms`
      // );
      console.log(`> 本地访问路径: ${blue("http://localhost:3003")}`);
      resolve(port);
    });
  });
}
