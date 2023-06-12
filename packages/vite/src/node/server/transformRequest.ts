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
import type { SourceDescription, SourceMap } from "rollup";
import { isFileServingAllowed } from "./middlewares/static";
import colors from "picocolors";
import path from "node:path";

const debugLoad = createDebugger("vite:load");
const debugTransform = createDebugger("vite:transform");
const debugCache = createDebugger("vite:cache");

export interface TransformResult {
  code: string;
  map: SourceMap | null;
  etag?: string;
  deps?: string[];
  dynamicDeps?: string[];
}

/**对transformMiddleware拦截的内容进行transform和resolveId */
export function transformRequest(
  url: string,
  server: ViteDevServer,
  options: TransformOptions = {}
): Promise<TransformResult | null> {
  const cacheKey = (options.html ? "html:" : "") + url;
  const timestamp = Date.now();
  // 检查缓存中是否存在正在处理的请求
  // 如果存在，并且缓存的请求仍然有效,则直接使用缓存的请求结果；
  // 否则，中止缓存的请求，并重新处理该请求。
  // 可以避免重复处理相同的请求，并确保在模块状态发生变化时获取最新的结果。
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
  // 利用pluginContainer和moduleGraph对资源进行转换处理，并将转换后的结果返回
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

  return request.finally(clearCache);
}
/**transform核心方法 */
async function doTransform(
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number
) {
  url = removeTimestampQuery(url);

  const { config, pluginContainer } = server;
  const prettyUrl = debugCache ? prettifyUrl(url, config.root) : "";
  // 判断当前url有没有被加进模块信息中
  const module = await server.moduleGraph.getModuleByUrl(url);
  // 如果有就命中缓存
  const cached = module && module.transformResult;
  if (cached) {
    debugCache?.(`[memory] ${prettyUrl}`);
    return cached;
  }
  // 否则调用 PluginContainer 的 resolveId 和 load 方法对进行模块加载
  const id =
    module?.id ?? (await pluginContainer.resolveId(url, undefined))?.id ?? url;
  // 对文件进行transfomr和load，将处理过后的资源文件放到模块管理图中
  // 并将模块的文件添加到热更新监听器中
  const result = loadAndTransform(id, url, server, options, timestamp);
  return result;
}
/**tranform时，对文件资源进行处理，并添加到模块管理图中进行管理 */
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
    if (options.html && !id.endsWith(".html")) {
      return null;
    }
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
  // 创建ModuleNode
  const mod = await moduleGraph.ensureEntryFromUrl(url);
  // 将模块添加进热更新监听列表中
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
    etag: getEtag(code, { weak: true }), // NOTE 协商缓存
  } as TransformResult;
  // 检查模块是否过时，是否需要更新
  if (timestamp > mod.lastInvalidationTimestamp) {
    mod.transformResult = result;
  }

  return result;
}
/**创建sourceMap */
function createConvertSourceMapReadMap(originalFileName: string) {
  return (filename: string) => {
    return fs.readFile(
      path.resolve(path.dirname(originalFileName), filename),
      "utf-8"
    );
  };
}
