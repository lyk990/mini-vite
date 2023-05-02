import { isCSSRequest } from "vite";
import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { cleanUrl, isJSRequest } from "../utils";

// TODO
/**注入热更新代码 */
export function importAnalysisPlugin(config?: ResolvedConfig): Plugin {
  return {
    name: "vite:import-analysis",
  } as Plugin;
}

export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(cleanUrl(url)) && !isCSSRequest(url);
}
