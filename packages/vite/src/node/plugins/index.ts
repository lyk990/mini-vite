import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { cssPlugin } from "./css";
import { importAnalysisPlugin } from "./importAnalysis";
import { resolvePlugin } from "./resolve";

export function resolvePlugins(
  config?: ResolvedConfig,
  prePlugins?: Plugin[],
  normalPlugins?: Plugin[],
  postPlugins?: Plugin[]
): Plugin[] {
  return [
    // clientInjectPlugin(),
    resolvePlugin(),
    // esbuildTransformPlugin(),
    // reactHMRPlugin(),
    importAnalysisPlugin(),
    cssPlugin(),
    // assetPlugin(),
  ];
}
