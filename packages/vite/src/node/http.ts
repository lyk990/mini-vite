import type { Logger } from "./logger";
import type { Server as HttpServer } from "node:http";
import type { Connect } from "dep-types/connect";

/**创建http服务器，返回http.Server 的新实例。 */
export async function resolveHttpServer(
  app: Connect.Server
): Promise<HttpServer> {
  const { createServer } = await import("node:http");
  return createServer(app);
}
/**开启服务器，并监听服务器端口 */
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
    // 创建http服务器异常处理
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
    httpServer.listen(port, host, async () => {
      httpServer.removeListener("error", onError);
      resolve(port);
    });
  });
}
