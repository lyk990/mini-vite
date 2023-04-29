import { TransformOptions, TransformResult } from "vite";
import { ViteDevServer } from ".";

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
  const { config, pluginContainer, moduleGraph } = server;
  const loadResult = await pluginContainer.load(id, { ssr: false });
}
