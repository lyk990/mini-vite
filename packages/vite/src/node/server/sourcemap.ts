import { createDebugger } from "../utils";
import type { ExistingRawSourceMap, SourceMap } from "rollup";
import { Logger } from "../logger";
import path from "node:path";
import { promises as fs } from "node:fs";

interface SourceMapLike {
  sources: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
}

const virtualSourceRE = /^(?:dep:|browser-external:|virtual:)|\0/;

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

export function applySourcemapIgnoreList(
  map: ExistingRawSourceMap,
  sourcemapPath: string,
  sourcemapIgnoreList: (sourcePath: string, sourcemapPath: string) => boolean,
  logger?: Logger
): void {
  let { x_google_ignoreList } = map;
  if (x_google_ignoreList === undefined) {
    x_google_ignoreList = [];
  }
  for (
    let sourcesIndex = 0;
    sourcesIndex < map.sources.length;
    ++sourcesIndex
  ) {
    const sourcePath = map.sources[sourcesIndex];
    if (!sourcePath) continue;

    const ignoreList = sourcemapIgnoreList(
      path.isAbsolute(sourcePath)
        ? sourcePath
        : path.resolve(path.dirname(sourcemapPath), sourcePath),
      sourcemapPath
    );
    if (logger && typeof ignoreList !== "boolean") {
      logger.warn("sourcemapIgnoreList function must return a boolean.");
    }

    if (ignoreList && !x_google_ignoreList.includes(sourcesIndex)) {
      x_google_ignoreList.push(sourcesIndex);
    }
  }

  if (x_google_ignoreList.length > 0) {
    if (!map.x_google_ignoreList) map.x_google_ignoreList = x_google_ignoreList;
  }
}

export async function injectSourcesContent(
  map: SourceMapLike,
  file: string,
  logger: Logger
): Promise<void> {
  let sourceRoot: string | undefined;
  try {
    // The source root is undefined for virtual modules and permission errors.
    sourceRoot = await fs.realpath(
      path.resolve(path.dirname(file), map.sourceRoot || "")
    );
  } catch (e) {
    console.log(e);
  }

  const missingSources: string[] = [];
  map.sourcesContent = await Promise.all(
    map.sources.map((sourcePath) => {
      if (sourcePath && !virtualSourceRE.test(sourcePath)) {
        sourcePath = decodeURI(sourcePath);
        if (sourceRoot) {
          sourcePath = path.resolve(sourceRoot, sourcePath);
        }
        return fs.readFile(sourcePath, "utf-8").catch((e) => {
          console.log(e);
          missingSources.push(sourcePath);
          return null;
        });
      }
      return null;
    })
  );

  if (missingSources.length) {
    logger.warnOnce(`Sourcemap for "${file}" points to missing source files`);
    debug?.(`Missing sources:\n  ` + missingSources.join(`\n  `));
  }
}
