import { TransformOptions, TransformResult } from "vite";
import { ViteDevServer } from ".";
import { blankReplacer, cleanUrl, ensureWatchedFile, isObject } from "../utils";
import { promises as fs } from "node:fs";
import convertSourceMap from "convert-source-map";
import { SourceDescription } from "rollup";

export function transformRequest(
  url: string,
  server: ViteDevServer,
  options: TransformOptions = {}
): Promise<TransformResult | null> {
  const timestamp = Date.now();
  const request = doTransform(url, server, options, timestamp);
  return request;
}

async function doTransform(
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number
) {
  const { config, pluginContainer } = server;
  const ssr = false;
  const module = await server.moduleGraph.getModuleByUrl(url, ssr);
  // 判断是否由缓存数据
  const cached =
    module && (ssr ? module.ssrTransformResult : module.transformResult);
  if (cached) {
    return cached;
  }
  // resolve
  const id =
    (await pluginContainer.resolveId(url, undefined, { ssr }))?.id || url;
  const result = loadAndTransform(id, url, server, options, timestamp);
  getDepsOptimizer(config, ssr)?.delayDepsOptimizerUntil(id, () => result);
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
  const loadResult = await pluginContainer.load(id, { ssr: false });
  let code: string | null = null;
  let map: SourceDescription["map"] = null;
  const ssr = false;
  const file = cleanUrl(id);
  // 读取文件
  if (loadResult == null) {
    if (options.html && !id.endsWith(".html")) {
      return null;
    }
    if (options.ssr || true) {
      try {
        code = await fs.readFile(file, "utf-8");
      } catch (e) {
        if (e.code !== "ENOENT") {
          throw e;
        }
      }
    }
    if (code) {
      try {
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
    if (isObject(loadResult)) {
      code = loadResult.code;
      map = loadResult.map;
    } else {
      code = loadResult;
    }
  }
  if (code == null) {
    const err: any = new Error(
      `Failed to load url ${url} (resolved id: ${id})`
    );
    throw err;
  }
  // 创建模块关系
  const mod = await moduleGraph.ensureEntryFromUrl(url, ssr);
  ensureWatchedFile(watcher, mod.file, root);
  // transform
  const transformStart = performance.now();
  const transformResult = await pluginContainer.transform(code, id, {
    inMap: map,
    ssr,
  });
}
