import type { Server } from "node:http";
import { STATUS_CODES, createServer as createHttpServer } from "node:http";
import {
  ErrorPayload,
  HMRPayload,
  InferCustomEventPayload,
  WebSocketClient,
  WebSocketCustomListener,
  WebSocket as WebSocketTypes,
} from "vite";
import { ResolvedConfig } from "../config";
import { WebSocketServer as WebSocketServerRaw } from "ws";
import colors from "picocolors";
import type { WebSocket as WebSocketRaw } from "ws";
import { isObject } from "../utils";
import { Socket } from "node:net";

export const HMR_HEADER = "vite-hmr";
export interface WebSocketServer {
  listen(): void;
  clients: Set<WebSocketClient>;
  send(payload: HMRPayload): void;
  send<T extends string>(event: T, payload?: InferCustomEventPayload<T>): void;
  close(): Promise<void>;
  on: WebSocketTypes.Server["on"] & {
    <T extends string>(
      event: T,
      listener: WebSocketCustomListener<InferCustomEventPayload<T>>
    ): void;
  };
  off: WebSocketTypes.Server["off"] & {
    (event: string, listener: Function): void;
  };
}
const wsServerEvents = [
  "connection",
  "error",
  "headers",
  "listening",
  "message",
];
export function createWebSocketServer(
  server: Server | null,
  config: ResolvedConfig
): WebSocketServer {
  let wss: WebSocketServerRaw;
  let wsHttpServer: Server | undefined = undefined;

  const hmr = isObject(config.server.hmr) && config.server.hmr;
  const hmrServer = hmr && hmr.server;
  const hmrPort = hmr && hmr.port;
  const portsAreCompatible = !hmrPort || hmrPort === config.server.port;
  const wsServer = hmrServer || (portsAreCompatible && server);
  const customListeners = new Map<string, Set<WebSocketCustomListener<any>>>();
  const clientsMap = new WeakMap<WebSocketRaw, WebSocketClient>();
  const port = hmrPort || 24678;
  const host = (hmr && hmr.host) || undefined;

  if (wsServer) {
    wss = new WebSocketServerRaw({ noServer: true });
    wsServer.on("upgrade", (req, socket, head) => {
      if (req.headers["sec-websocket-protocol"] === HMR_HEADER) {
        wss.handleUpgrade(req, socket as Socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      }
    });
  } else {
    const route = ((_, res) => {
      const statusCode = 426;
      const body = STATUS_CODES[statusCode];
      if (!body)
        throw new Error(`No body text found for the ${statusCode} status code`);

      res.writeHead(statusCode, {
        "Content-Length": body.length,
        "Content-Type": "text/plain",
      });
      res.end(body);
    }) as Parameters<typeof createHttpServer>[1];
    wsHttpServer = createHttpServer(route);
    wss = new WebSocketServerRaw({ server: wsHttpServer });
  }

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      if (!customListeners.size) return;
      let parsed: any;
      try {
        parsed = JSON.parse(String(raw));
      } catch (e) {}
      if (!parsed || parsed.type !== "custom" || !parsed.event) return;
      const listeners = customListeners.get(parsed.event);
      if (!listeners?.size) return;
      const client = getSocketClient(socket);
      listeners.forEach((listener) => listener(parsed.data, client));
    });
    socket.on("error", (err) => {
      config.logger.error(`${colors.red(`ws error:`)}\n${err.stack}`, {
        timestamp: true,
        error: err,
      });
    });
    socket.send(JSON.stringify({ type: "connected" }));
    if (bufferedError) {
      socket.send(JSON.stringify(bufferedError));
      bufferedError = null;
    }
  });

  wss.on("error", (e: Error & { code: string }) => {
    if (e.code === "EADDRINUSE") {
      config.logger.error(
        colors.red(`WebSocket server error: Port is already in use`),
        { error: e }
      );
    } else {
      config.logger.error(
        colors.red(`WebSocket server error:\n${e.stack || e.message}`),
        { error: e }
      );
    }
  });
  let bufferedError: ErrorPayload | null = null;

  function getSocketClient(socket: WebSocketRaw) {
    if (!clientsMap.has(socket)) {
      clientsMap.set(socket, {
        send: (...args) => {
          let payload: HMRPayload;
          if (typeof args[0] === "string") {
            payload = {
              type: "custom",
              event: args[0],
              data: args[1],
            };
          } else {
            payload = args[0];
          }
          socket.send(JSON.stringify(payload));
        },
        socket,
      });
    }
    return clientsMap.get(socket)!;
  }

  return {
    listen: () => {
      wsHttpServer?.listen(port, host);
    },
    on: ((event: string, fn: () => void) => {
      if (wsServerEvents.includes(event)) wss.on(event, fn);
      else {
        if (!customListeners.has(event)) {
          customListeners.set(event, new Set());
        }
        customListeners.get(event)!.add(fn);
      }
    }) as WebSocketServer["on"],
    off: ((event: string, fn: () => void) => {
      if (wsServerEvents.includes(event)) {
        wss.off(event, fn);
      } else {
        customListeners.get(event)?.delete(fn);
      }
    }) as WebSocketServer["off"],

    get clients() {
      return new Set(Array.from(wss.clients).map(getSocketClient));
    },

    send(...args: any[]) {
      let payload: HMRPayload;
      if (typeof args[0] === "string") {
        payload = {
          type: "custom",
          event: args[0],
          data: args[1],
        };
      } else {
        payload = args[0];
      }

      if (payload.type === "error" && !wss.clients.size) {
        bufferedError = payload;
        return;
      }

      const stringified = JSON.stringify(payload);
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(stringified);
        }
      });
    },

    close() {
      return new Promise((resolve, reject) => {
        wss.clients.forEach((client) => {
          client.terminate();
        });
        wss.close((err) => {
          if (err) {
            reject(err);
          } else {
            if (wsHttpServer) {
              wsHttpServer.close((err) => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
            } else {
              resolve();
            }
          }
        });
      });
    },
  };
}
