import { TransformOptions } from "vite";
import { ViteDevServer } from ".";
import {
  blankReplacer,
  cleanUrl,
  createDebugger,
  ensureWatchedFile,
  isObject,
  prettifyUrl,
  removeTimestampQuery,
  timeFrom,
} from "../utils";
import { promises as fs } from "node:fs";
import convertSourceMap from "convert-source-map";
import getEtag from "etag";
import { getDepsOptimizer } from "../optimizer/optimizer";
import type { SourceDescription, SourceMap } from "rollup";
import { isFileServingAllowed } from "./middlewares/static";
import colors from "picocolors";
import path from "node:path";

const debugLoad = createDebugger("vite:load");
const debugTransform = createDebugger("vite:transform");
const debugCache = createDebugger("vite:cache");

export const ERR_LOAD_PUBLIC_URL = "ERR_LOAD_PUBLIC_URL";
export const ERR_LOAD_URL = "ERR_LOAD_URL";

export interface TransformResult {
  code: string;
  map: SourceMap | null;
  etag?: string;
  deps?: string[];
  dynamicDeps?: string[];
}

export function transformRequest(
  url: string,
  server: ViteDevServer,
  options: TransformOptions = {}
): Promise<TransformResult | null> {
  const cacheKey = (options.html ? "html:" : "") + url;
  const timestamp = Date.now();

  const pending = server._pendingRequests.get(cacheKey);
  if (pending) {
    return server.moduleGraph
      .getModuleByUrl(removeTimestampQuery(url))
      .then((module) => {
        if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
          return pending.request;
        } else {
          pending.abort();
          return transformRequest(url, server, options);
        }
      });
  }

  const request = doTransform(url, server, options, timestamp);

  let cleared = false;
  const clearCache = () => {
    if (!cleared) {
      server._pendingRequests.delete(cacheKey);
      cleared = true;
    }
  };

  server._pendingRequests.set(cacheKey, {
    request,
    timestamp,
    abort: clearCache,
  });
  request.then(clearCache, clearCache);

  return request;
}

async function doTransform(
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number
) {
  url = removeTimestampQuery(url);

  const { config, pluginContainer } = server;
  const prettyUrl = debugCache ? prettifyUrl(url, config.root) : "";
  const module = await server.moduleGraph.getModuleByUrl(url);

  const cached = module && module.transformResult;
  if (cached) {
    debugCache?.(`[memory] ${prettyUrl}`);
    return cached;
  }
  const id =
    module?.id ?? (await pluginContainer.resolveId(url, undefined))?.id ?? url;
  const result = loadAndTransform(id, url, server, options, timestamp);
  getDepsOptimizer(config)?.delayDepsOptimizerUntil(id, () => result);
  return result;
}

async function loadAndTransform(
  id: string,
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number
) {
  const { config, pluginContainer, moduleGraph, watcher } = server;
  const { root, logger } = config;
  const prettyUrl =
    debugLoad || debugTransform ? prettifyUrl(url, config.root) : "";

  const file = cleanUrl(id);

  let code: string | null = null;
  let map: SourceDescription["map"] = null;

  const loadStart = debugLoad ? performance.now() : 0;
  const loadResult = await pluginContainer.load(id);
  if (loadResult == null) {
    if (isFileServingAllowed(file, server)) {
      try {
        code = await fs.readFile(file, "utf-8");
        debugLoad?.(`${timeFrom(loadStart)} [fs] ${prettyUrl}`);
      } catch (e) {
        if (e.code !== "ENOENT") {
          throw e;
        }
      }
    }
    if (code) {
      try {
        map = (
          convertSourceMap.fromSource(code) ||
          (await convertSourceMap.fromMapFileSource(
            code,
            createConvertSourceMapReadMap(file)
          ))
        )?.toObject();

        code = code.replace(
          convertSourceMap.mapFileCommentRegex,
          blankReplacer
        );
      } catch (e) {
        logger.warn(`Failed to load source map for ${url}.`, {
          timestamp: true,
        });
      }
    }
  } else {
    debugLoad?.(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`);
    if (isObject(loadResult)) {
      code = loadResult.code;
      map = loadResult.map;
    } else {
      code = loadResult;
    }
  }
  if (code == null) {
    throw new Error(`Failed to load url`);
  }
  const mod = await moduleGraph.ensureEntryFromUrl(url);
  ensureWatchedFile(watcher, mod.file, root);
  const transformStart = debugTransform ? performance.now() : 0;
  const transformResult = await pluginContainer.transform(code, id, {
    inMap: map,
  });
  if (
    transformResult == null ||
    (isObject(transformResult) && transformResult.code == null)
  ) {
    debugTransform?.(
      timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`)
    );
  } else {
    debugTransform?.(`${timeFrom(transformStart)} ${prettyUrl}`);
    code = transformResult.code!;
    map = transformResult.map;
  }

  if (map && mod.file) {
    map = (typeof map === "string" ? JSON.parse(map) : map) as SourceMap;

    if (path.isAbsolute(mod.file)) {
      for (
        let sourcesIndex = 0;
        sourcesIndex < map.sources.length;
        ++sourcesIndex
      ) {
        const sourcePath = map.sources[sourcesIndex];
        if (sourcePath) {
          if (path.isAbsolute(sourcePath)) {
            map.sources[sourcesIndex] = path.relative(
              path.dirname(mod.file),
              sourcePath
            );
          }
        }
      }
    }
  }

  const result = {
    code,
    map,
    etag: getEtag(code, { weak: true }),
  } as TransformResult;

  if (timestamp > mod.lastInvalidationTimestamp) {
    mod.transformResult = result;
  }

  return result;
}

function createConvertSourceMapReadMap(originalFileName: string) {
  return (filename: string) => {
    return fs.readFile(
      path.resolve(path.dirname(originalFileName), filename),
      "utf-8"
    );
  };
}
