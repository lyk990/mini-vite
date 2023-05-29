import connect from "connect";
import type { Connect } from "dep-types/connect";
import { createPluginContainer, PluginContainer } from "../pluginContainer";
import { DEFAULT_DEV_PORT, DEFAULT_HOST_NAME } from "../constants";
import {
  InlineConfig,
  ServerOptions,
  FileSystemServeOptions,
  TransformResult,
  mergeConfig,
  TransformOptions,
} from "vite";
import { ModuleGraph } from "./moduleGraph";
import type * as http from "node:http";
import { httpServerStart, resolveHttpServer } from "../http";
import { resolveConfig } from "../config";
import { ResolvedConfig } from "../config";
import { diffDnsOrderChange, normalizePath, resolveServerUrls } from "../utils";
import { printServerUrls } from "../logger";
import { transformMiddleware } from "./middlewares/transform";
import { FSWatcher } from "chokidar";
import chokidar from "chokidar";
import { createWebSocketServer, WebSocketServer } from "./ws";
import { handleFileAddUnlink, handleHMRUpdate } from "./hmr";
import { bindShortcuts, BindShortcutsOptions } from "../shortcuts";
import { initDepsOptimizer } from "../optimizer/optimizer";
import type * as net from "node:net";
import { transformRequest } from "./transformRequest";
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from "./middlewares/indexHtml";
import {
  servePublicMiddleware,
  serveStaticMiddleware,
} from "./middlewares/static";
import path from "node:path";
import { resolveChokidarOptions } from "../watch";
import { htmlFallbackMiddleware } from "./middlewares/htmlFallback";
import { searchForWorkspaceRoot } from "./searchRoot";

export interface ResolvedServerUrls {
  local: string[];
  network: string[];
}

export interface ResolvedServerOptions extends ServerOptions {
  fs: Required<FileSystemServeOptions>;
  middlewareMode: boolean;
}

export interface ViteDevServer {
  root: string;
  middlewares: connect.Server;
  httpServer: http.Server | null;
  pluginContainer: PluginContainer;
  config: ResolvedConfig;
  resolvedUrls: ResolvedServerUrls | null;
  printUrls(): void;
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>;
  moduleGraph: ModuleGraph;
  watcher: FSWatcher;
  ws: WebSocketServer;
  restart(forceOptimize?: boolean): Promise<void>;
  _restartPromise: Promise<void> | null;
  _forceOptimizeOnRestart: boolean;
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>;
      timestamp: number;
      abort: () => void;
    }
  >;
  _importGlobMap: Map<string, string[][]>;
  _shortcutsOptions: any | undefined;
  close(): Promise<void>;
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string
  ): Promise<string>;
  transformRequest(
    url: string,
    options?: TransformOptions
  ): Promise<TransformResult | null>;
}

/**开启http服务器*/
async function startServer(server: ViteDevServer) {
  const httpServer = server.httpServer;
  if (!httpServer) {
    throw new Error("Cannot call server.listen in middleware mode.");
  }
  const port = DEFAULT_DEV_PORT;
  let hostName = DEFAULT_HOST_NAME;
  await httpServerStart(httpServer, {
    port,
    strictPort: false,
    host: hostName,
    logger: server.config.logger,
  });
}

/**关闭http服务器 */
function createServerCloseFn(server: http.Server | null) {
  if (!server) {
    return () => {};
  }

  let hasListened = false;
  const openSockets = new Set<net.Socket>();

  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => {
      openSockets.delete(socket);
    });
  });

  server.once("listening", () => {
    hasListened = true;
  });

  return () =>
    new Promise<void>((resolve, reject) => {
      openSockets.forEach((s) => s.destroy());
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
}

export async function createServer(
  inlineConfig: InlineConfig = {}
): Promise<ViteDevServer> {
  return _createServer(inlineConfig);
}

export async function _createServer(
  inlineConfig: InlineConfig = {}
): Promise<ViteDevServer> {
  const config = await resolveConfig(inlineConfig, "serve");

  const { root, server: serverConfig } = config;
  const { middlewareMode } = serverConfig;
  const middlewares = connect() as Connect.Server;

  const resolvedWatchOptions = resolveChokidarOptions(config, {
    disableGlobbing: true,
    ...serverConfig.watch,
  });

  const httpServer = await resolveHttpServer(middlewares);
  const ws = createWebSocketServer(httpServer, config);

  const moduleGraph: ModuleGraph = new ModuleGraph((url) =>
    container.resolveId(url, undefined)
  );
  const container = await createPluginContainer(config);
  const closeHttpServer = createServerCloseFn(httpServer);

  const watcher = chokidar.watch(
    [root, ...config.configFileDependencies, path.join(config.envDir, ".env*")],
    resolvedWatchOptions
  ) as FSWatcher;

  const onHMRUpdate = async (file: string, configOnly: boolean) => {
    if (serverConfig.hmr !== false) {
      try {
        await handleHMRUpdate(file, server, configOnly);
      } catch (err) {
        ws.send({
          type: "error",
          err,
        });
      }
    }
  };
  const onFileAddUnlink = async (file: string) => {
    file = normalizePath(file);
    await handleFileAddUnlink(file, server);
    await onHMRUpdate(file, true);
  };
  // 文件改变时
  watcher.on("change", async (file) => {
    file = normalizePath(file);
    moduleGraph.onFileChange(file);

    await onHMRUpdate(file, false);
  });
  // 新增文件时
  watcher.on("add", onFileAddUnlink);
  // 删除文件时
  watcher.on("unlink", onFileAddUnlink);
  let exitProcess: () => void;

  const server: ViteDevServer = {
    root,
    middlewares,
    httpServer,
    pluginContainer: container,
    config,
    moduleGraph,
    resolvedUrls: null,
    watcher,
    ws,
    transformRequest(url, options) {
      return transformRequest(url, server, options);
    },
    transformIndexHtml: null!,
    async listen() {
      await startServer(server);
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
    async close() {
      if (!middlewareMode) {
        process.off("SIGTERM", exitProcess);
        if (process.env.CI !== "true") {
          process.stdin.off("end", exitProcess);
        }
      }
      await Promise.allSettled([
        watcher.close(),
        ws.close(),
        container.close(),
        closeHttpServer(),
      ]);
      server.resolvedUrls = null;
    },
    async restart(forceOptimize?: boolean) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize;
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null;
          server._forceOptimizeOnRestart = false;
        });
      }
      return server._restartPromise;
    },
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map(),
    _shortcutsOptions: undefined,
  };
  server.transformIndexHtml = createDevHtmlTransformFn(server);

  const postHooks: ((() => void) | void)[] = [];
  for (const hook of config.getSortedPluginHooks("configureServer")) {
    postHooks.push(await hook(server));
  }

  if (config.publicDir) {
    middlewares.use(
      servePublicMiddleware(config.publicDir, config.server.headers)
    );
  }

  middlewares.use(transformMiddleware(server));
  middlewares.use(serveStaticMiddleware(root, server));
  middlewares.use(htmlFallbackMiddleware(root));

  postHooks.forEach((fn) => fn && fn());

  middlewares.use(indexHtmlMiddleware(server));
  // 初始化服务器
  let initingServer: Promise<void> | undefined;
  let serverInited = false;
  const initServer = async () => {
    if (serverInited) return;
    if (initingServer) return initingServer;

    initingServer = (async function () {
      await container.buildStart({});
      await initDepsOptimizer(config);
      initingServer = undefined;
      serverInited = true;
    })();
    return initingServer;
  };

  const listen = httpServer.listen.bind(httpServer);
  httpServer.listen = (async (port: number, ...args: any[]) => {
    try {
      ws.listen();
      await initServer();
    } catch (e) {
      httpServer.emit("error", e);
      return;
    }
    return listen(port, ...args);
  }) as any;
  return server;
}

async function restartServer(server: ViteDevServer) {
  global.__vite_start_time = performance.now();
  const { port: prevPort, host: prevHost } = server.config.server;
  const shortcutsOptions: BindShortcutsOptions = server._shortcutsOptions;
  const oldUrls = server.resolvedUrls;

  let inlineConfig = server.config.inlineConfig;
  if (server._forceOptimizeOnRestart) {
    inlineConfig = mergeConfig(inlineConfig, {
      optimizeDeps: {
        force: true,
      },
    });
  }

  let newServer = null;
  try {
    newServer = await _createServer(inlineConfig);
  } catch (err: any) {
    server.config.logger.error(err.message, {
      timestamp: true,
    });
    server.config.logger.error("server restart failed", { timestamp: true });
    return;
  }

  await server.close();

  newServer._restartPromise = server._restartPromise;

  Object.assign(server, newServer);

  const {
    logger,
    server: { port, host, middlewareMode },
  } = server.config;
  if (!middlewareMode) {
    await server.listen(port, true);
    logger.info("server restarted.", { timestamp: true });
    if (
      (port ?? DEFAULT_DEV_PORT) !== (prevPort ?? DEFAULT_DEV_PORT) ||
      host !== prevHost ||
      diffDnsOrderChange(oldUrls, newServer.resolvedUrls)
    ) {
      logger.info("");
      server.printUrls();
    }
  } else {
    server.ws.listen();
    logger.info("server restarted.", { timestamp: true });
  }

  if (shortcutsOptions) {
    shortcutsOptions.print = false;
    bindShortcuts(newServer, shortcutsOptions);
  }

  newServer._restartPromise = null;
}
/**获取vite.config.ts中的server配置项*/
export function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined
): ResolvedServerOptions {
  const server: ResolvedServerOptions = {
    preTransformRequests: true,
    ...(raw as Omit<ResolvedServerOptions, "sourcemapIgnoreList">),
    middlewareMode: !!raw?.middlewareMode,
  };
  let allowDirs = server.fs?.allow;
  const deny = server.fs?.deny || [".env", ".env.*", "*.{crt,pem}"];

  if (!allowDirs) {
    allowDirs = [searchForWorkspaceRoot(root)];
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i));

  server.fs = {
    strict: server.fs?.strict ?? true,
    allow: allowDirs,
    deny,
  };
  return server;
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir));
}
