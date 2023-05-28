import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import type { SourceMap } from "rollup";
import getEtag from "etag";

export interface SendOptions {
  etag?: string;
  cacheControl?: string;
  headers?: OutgoingHttpHeaders;
  map?: SourceMap | null;
}

const alias: Record<string, string | undefined> = {
  js: "application/javascript",
  css: "text/css",
  html: "text/html",
  json: "application/json",
};

export function send(
  req: IncomingMessage,
  res: ServerResponse,
  content: string | Buffer,
  type: string,
  options: SendOptions
): void {
  const {
    etag = getEtag(content, { weak: true }),
    cacheControl = "no-cache",
    headers,
  } = options;

  if (res.writableEnded) {
    return;
  }

  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  res.setHeader("Content-Type", alias[type] || type);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Etag", etag);

  if (headers) {
    for (const name in headers) {
      res.setHeader(name, headers[name]!);
    }
  }

  res.statusCode = 200;
  res.end(content);
  return;
}
