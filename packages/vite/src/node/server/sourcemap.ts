import type { SourceMap } from "rollup";
import { createDebugger } from "../utils";

const debug = createDebugger("vite:sourcemap", {
  onlyWhenFocused: true,
});

export function getCodeWithSourcemap(
  type: "js" | "css",
  code: string,
  map: SourceMap
): string {
  if (debug) {
    code += `\n/*${JSON.stringify(map, null, 2).replace(/\*\//g, "*\\/")}*/\n`;
  }

  if (type === "js") {
    code += `\n//# sourceMappingURL=${genSourceMapUrl(map)}`;
  } else if (type === "css") {
    code += `\n/*# sourceMappingURL=${genSourceMapUrl(map)} */`;
  }

  return code;
}

export function genSourceMapUrl(map: SourceMap | string): string {
  if (typeof map !== "string") {
    map = JSON.stringify(map);
  }
  return `data:application/json;base64,${Buffer.from(map).toString("base64")}`;
}
