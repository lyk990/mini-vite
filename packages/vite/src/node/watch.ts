import glob from "fast-glob";
import type { WatchOptions } from "dep-types/chokidar";
import type { ResolvedConfig } from ".";
/**热更新Chokidar 配置项 */
export function resolveChokidarOptions(
  config: ResolvedConfig,
  options: WatchOptions | undefined
): WatchOptions {
  const { ignored = [], ...otherOptions } = options ?? {};

  const resolvedWatchOptions: WatchOptions = {
    ignored: [
      "**/.git/**",
      "**/node_modules/**",
      "**/test-results/**",
      glob.escapePath(config.cacheDir) + "/**",
      ...(Array.isArray(ignored) ? ignored : [ignored]),
    ],
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ...otherOptions,
  };

  return resolvedWatchOptions;
}
