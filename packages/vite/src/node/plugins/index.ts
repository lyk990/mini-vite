import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";

export function resolvePlugins(
  config?: ResolvedConfig,
  prePlugins?: Plugin[],
  normalPlugins?: Plugin[],
  postPlugins?: Plugin[]
): Plugin[] {
  return [
    // clientInjectPlugin(),
    // resolvePlugin(),
    // esbuildTransformPlugin(),
    // reactHMRPlugin(),
    // importAnalysisPlugin(),
    // cssPlugin(),
    // assetPlugin(),
  ];
}
