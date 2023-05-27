// import type * as http from "node:http";
// import type * as net from "node:net";
// import httpProxy from "http-proxy";
// import type { Connect } from "dep-types/connect";
// import type { HttpProxy } from "dep-types/http-proxy";
// import colors from "picocolors";
// import { HMR_HEADER } from "../ws";
// import { createDebugger } from "../../utils";
// import type { CommonServerOptions, ResolvedConfig } from "../..";

// const debug = createDebugger("vite:proxy");

// export interface ProxyOptions extends HttpProxy.ServerOptions {
//   rewrite?: (path: string) => string;
//   configure?: (proxy: HttpProxy.Server, options: ProxyOptions) => void;
//   bypass?: (
//     req: http.IncomingMessage,
//     res: http.ServerResponse,
//     options: ProxyOptions
//   ) => void | null | undefined | false | string;
// }

// export function proxyMiddleware(
//   httpServer: http.Server | null,
//   options: NonNullable<CommonServerOptions["proxy"]>,
//   config: ResolvedConfig
// ): Connect.NextHandleFunction {
//   const proxies: Record<string, [HttpProxy.Server, ProxyOptions]> = {};

//   Object.keys(options).forEach((context) => {
//     let opts = options[context];
//     if (!opts) {
//       return;
//     }
//     if (typeof opts === "string") {
//       opts = { target: opts, changeOrigin: true } as ProxyOptions;
//     }
//     const proxy = httpProxy.createProxyServer(opts) as HttpProxy.Server;

//     if (opts.configure) {
//       opts.configure(proxy, opts);
//     }

//     proxy.on("error", (err, req, originalRes) => {
//       const res = originalRes as http.ServerResponse | net.Socket;
//       if ("req" in res) {
//         config.logger.error(
//           `${colors.red(`http proxy error at ${originalRes.req.url}:`)}\n${
//             err.stack
//           }`,
//           {
//             timestamp: true,
//             error: err,
//           }
//         );
//         if (!res.headersSent && !res.writableEnded) {
//           res
//             .writeHead(500, {
//               "Content-Type": "text/plain",
//             })
//             .end();
//         }
//       } else {
//         config.logger.error(`${colors.red(`ws proxy error:`)}\n${err.stack}`, {
//           timestamp: true,
//           error: err,
//         });
//         res.end();
//       }
//     });
//     proxies[context] = [proxy, { ...opts }];
//   });

//   if (httpServer) {
//     httpServer.on("upgrade", (req, socket, head) => {
//       const url = req.url!;
//       for (const context in proxies) {
//         if (doesProxyContextMatchUrl(context, url)) {
//           const [proxy, opts] = proxies[context];
//           if (
//             (opts.ws ||
//               opts.target?.toString().startsWith("ws:") ||
//               opts.target?.toString().startsWith("wss:")) &&
//             req.headers["sec-websocket-protocol"] !== HMR_HEADER
//           ) {
//             if (opts.rewrite) {
//               req.url = opts.rewrite(url);
//             }
//             debug?.(`${req.url} -> ws ${opts.target}`);
//             proxy.ws(req, socket, head);
//             return;
//           }
//         }
//       }
//     });
//   }

//   return function viteProxyMiddleware(req, res, next) {
//     const url = req.url!;
//     for (const context in proxies) {
//       if (doesProxyContextMatchUrl(context, url)) {
//         const [proxy, opts] = proxies[context];
//         const options: HttpProxy.ServerOptions = {};

//         if (opts.bypass) {
//           const bypassResult = opts.bypass(req, res, opts);
//           if (typeof bypassResult === "string") {
//             req.url = bypassResult;
//             debug?.(`bypass: ${req.url} -> ${bypassResult}`);
//             return next();
//           } else if (bypassResult === false) {
//             debug?.(`bypass: ${req.url} -> 404`);
//             return res.end(404);
//           }
//         }

//         debug?.(`${req.url} -> ${opts.target || opts.forward}`);
//         if (opts.rewrite) {
//           req.url = opts.rewrite(req.url!);
//         }
//         proxy.web(req, res, options);
//         return;
//       }
//     }
//     next();
//   };
// }

// function doesProxyContextMatchUrl(context: string, url: string): boolean {
//   return (
//     (context[0] === "^" && new RegExp(context).test(url)) ||
//     url.startsWith(context)
//   );
// }
