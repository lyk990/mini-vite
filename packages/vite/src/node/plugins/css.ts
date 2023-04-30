import { ResolvedConfig } from "../config";
import { CSS_LANGS_RE } from "../constants";
import { Plugin } from "../plugin";

const directRequestRE = /(?:\?|&)direct\b/;

export const isDirectCSSRequest = (request: string): boolean =>
  CSS_LANGS_RE.test(request) && directRequestRE.test(request);
// TODO
export function cssPlugin(config?: ResolvedConfig): Plugin {
  return {} as Plugin;
}
