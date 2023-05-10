import connect from "connect";
import type { Connect } from "dep-types/connect";
// import { optimize } from "../optimizer/index";
import { resolvePlugins } from "../plugins";
import { createPluginContainer, PluginContainer } from "../pluginContainer";
import { Plugin } from "../plugin";
import { CLIENT_DIR, DEFAULT_DEV_PORT, DEFAULT_HOST_NAME } from "../constants";
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
import {
  diffDnsOrderChange,
  isInNodeModules,
  normalizePath,
  resolveServerUrls,
} from "../utils";
import { Logger, printServerUrls } from "../logger";
import { transformMiddleware } from "./middlewares/transform";
import { FSWatcher } from "chokidar";
import chokidar from "chokidar";
import { createWebSocketServer, WebSocketServer } from "./ws";
import { handleFileAddUnlink, handleHMRUpdate } from "./hmr";
import { bindShortcuts, BindShortcutsOptions } from "../shortcuts";
import { getDepsOptimizer, initDepsOptimizer } from "../optimizer/optimizer";
import type * as net from "node:net";
import { openBrowser as _openBrowser } from "./openBrowser";
import { transformRequest } from "./transformRequest";
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from "./middlewares/indexHtml";
import colors from "picocolors";
import {
  serveRawFsMiddleware,
  serveStaticMiddleware,
} from "./middlewares/static";
import picomatch from "picomatch";
import type { Matcher } from "picomatch";
import { proxyMiddleware } from "./middlewares/proxy";

export interface ResolvedServerUrls {
  local: string[];
  network: string[];
}

export interface ResolvedServerOptions extends ServerOptions {
  fs: Required<FileSystemServeOptions>;
  middlewareMode: boolean;
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
  config: ResolvedConfig;
  resolvedUrls: ResolvedServerUrls | null;
  printUrls(): void;
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>;
  moduleGraph: ModuleGraph;
  watcher: FSWatcher;
  ws: WebSocketServer;
  restart(forceOptimize?: boolean): Promise<void>;
  _ssrExternals: string[] | null;
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
  openBrowser(): void;
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string
  ): Promise<string>;
  transformRequest(
    url: string,
    options?: TransformOptions
  ): Promise<TransformResult | null>;
  _fsDenyGlob: Matcher;
}

/**开启服务器,1、resolveHostname,2、 httpServerStart*/
async function startServer(server: ViteDevServer, inlinePort?: number) {
  const httpServer = server.httpServer;
  if (!httpServer) {
    throw new Error("Cannot call server.listen in middleware mode.");
  }
  const port = inlinePort ?? DEFAULT_DEV_PORT;
  // FEATURE 本地服务器
  let hostName = DEFAULT_HOST_NAME;
  await httpServerStart(httpServer, {
    port,
    strictPort: false,
    host: hostName,
    logger: server.config.logger,
  });
}

export async function createServer(
  inlineConfig: InlineConfig = {}
): Promise<ViteDevServer> {
  return _createServer(inlineConfig, { ws: true });
}

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
/** 创建server监听端口、解析vite配置、解析http配置、解析chokidar配置 */
export async function _createServer(
  inlineConfig: InlineConfig = {},
  options: { ws: boolean }
): Promise<ViteDevServer> {
  const config = await resolveConfig(inlineConfig, "serve");
  await initDepsOptimizer(config);

  const { root, server: serverConfig } = config;
  const { middlewareMode } = serverConfig;
  const middlewares = connect() as Connect.Server;

  const httpServer = await resolveHttpServer(middlewares);
  const httpsOptions = undefined; // REMOVE
  const ws = createWebSocketServer(httpServer, config, httpsOptions);

  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr })
  );
  const container = await createPluginContainer(config);
  const closeHttpServer = createServerCloseFn(httpServer);

  const watcher = chokidar.watch(root, {
    ignored: ["**/node_modules/**", "**/.git/**"],
    ignoreInitial: true,
  }) as FSWatcher;

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
  watcher.on("change", async (file) => {
    file = normalizePath(file);
    // invalidate module graph cache on file change
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
    transformIndexHtml: null!, // to be immediately set
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
    openBrowser() {
      const options = server.config.server;
      const url = server.resolvedUrls?.local[0];
      if (url) {
        const path =
          typeof options.open === "string"
            ? new URL(options.open, url).href
            : url;

        _openBrowser(path, true, server.config.logger);
      } else {
        server.config.logger.warn("No URL available to open in browser");
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
        getDepsOptimizer(server.config)?.close(),
        getDepsOptimizer(server.config, true)?.close(),
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
    _ssrExternals: null,
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map(),
    _fsDenyGlob: picomatch(config.server.fs.deny, { matchBase: true }),
    _shortcutsOptions: undefined,
  };
  const { proxy } = serverConfig;
  if (proxy) {
    middlewares.use(proxyMiddleware(httpServer, proxy, config));
  }
  middlewares.use(transformMiddleware(server));
  middlewares.use(serveRawFsMiddleware(server));
  middlewares.use(serveStaticMiddleware(root, server));
  server.transformIndexHtml = createDevHtmlTransformFn(server);
  if (config.appType === "spa" || config.appType === "mpa") {
    middlewares.use(indexHtmlMiddleware(server));
  }
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
    newServer = await _createServer(inlineConfig, { ws: false });
  } catch (err: any) {
    server.config.logger.error(err.message, {
      timestamp: true,
    });
    server.config.logger.error("server restart failed", { timestamp: true });
    return;
  }

  await server.close();

  // prevent new server `restart` function from calling
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

  // new server (the current server) can restart now
  newServer._restartPromise = null;
}

export function resolveServerOptions(
  root: string, //REMOVE
  raw: ServerOptions | undefined,
  logger: Logger // REMOVE
): ResolvedServerOptions {
  const server: ResolvedServerOptions = {
    preTransformRequests: true,
    ...(raw as Omit<ResolvedServerOptions, "sourcemapIgnoreList">),
    // REMOVE sourcemapIgnoreList sourcemap 忽略列表
    sourcemapIgnoreList:
      raw?.sourcemapIgnoreList === false
        ? () => false
        : raw?.sourcemapIgnoreList || isInNodeModules,
    middlewareMode: !!raw?.middlewareMode,
  };
  const deny = [".env", ".env.*", "*.{crt,pem}"];
  let allowDirs = [
    "C:/Users/Administrator/Desktop/learn-Code/vite源码/mini-vite",
  ];

  server.fs = {
    strict: server.fs?.strict ?? true,
    allow: allowDirs,
    deny,
  };
  return server;
}
