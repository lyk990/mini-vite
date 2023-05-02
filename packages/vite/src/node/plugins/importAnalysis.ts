import { isCSSRequest } from "vite";
import { ResolvedConfig } from "../config";
import { Plugin } from "../plugin";
import { cleanUrl, isJSRequest } from "../utils";

export function importAnalysisPlugin(config?: ResolvedConfig): Plugin {
  return {} as Plugin;
}

export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(cleanUrl(url)) && !isCSSRequest(url);
}
