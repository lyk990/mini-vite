import fs from "node:fs";
import path from "node:path";
import colors from "picocolors";
import { ResolvedConfig } from "../config";
import type { Plugin } from "../plugin";
import type {
  Loader,
  Message,
  TransformOptions,
  TransformResult,
} from "esbuild";
import {
  cleanUrl,
  combineSourcemaps,
  createDebugger,
  createFilter,
  generateCodeFrame,
  timeFrom,
} from "../utils";
import { ViteDevServer } from "../server";
import { searchForWorkspaceRoot } from "../server/searchRoot";
import type { TSConfckParseOptions } from "tsconfck";
import type { InternalModuleFormat, SourceMap } from "rollup";
import { TSConfckParseError, findAll, parse } from "tsconfck";
import { transform } from "esbuild";
import type { RawSourceMap } from "@ampproject/remapping";
import type { FSWatcher } from "chokidar";

const debug = createDebugger("vite:esbuild");

const INJECT_HELPERS_IIFE_RE =
  /^(.*?)((?:const|var)\s+\S+\s*=\s*function\s*\([^)]*\)\s*\{.*?"use strict";)/s;
const INJECT_HELPERS_UMD_RE =
  /^(.*?)(\(function\([^)]*\)\s*\{.+?amd.+?function\([^)]*\)\s*\{.*?"use strict";)/s;

const validExtensionRE = /\.\w+$/;
const jsxExtensionsRE = /\.(?:j|t)sx\b/;

export interface ESBuildOptions extends TransformOptions {
  include?: string | RegExp | string[] | RegExp[];
  exclude?: string | RegExp | string[] | RegExp[];
  jsxInject?: string;
  minify?: never;
}

export type ESBuildTransformResult = Omit<TransformResult, "map"> & {
  map: SourceMap;
};

type TSConfigJSON = {
  extends?: string;
  compilerOptions?: {
    alwaysStrict?: boolean;
    importsNotUsedAsValues?: "remove" | "preserve" | "error";
    jsx?: "preserve" | "react" | "react-jsx" | "react-jsxdev";
    jsxFactory?: string;
    jsxFragmentFactory?: string;
    jsxImportSource?: string;
    preserveValueImports?: boolean;
    target?: string;
    useDefineForClassFields?: boolean;
  };
  [key: string]: any;
};

type TSCompilerOptions = NonNullable<TSConfigJSON["compilerOptions"]>;

let tsconfckRoot: string | undefined;
let tsconfckParseOptions: TSConfckParseOptions | Promise<TSConfckParseOptions> =
  { resolveWithEmptyIfConfigNotFound: true };

let server: ViteDevServer;
export function esbuildPlugin(config: ResolvedConfig): Plugin {
  const options = config.esbuild as ESBuildOptions;
  const { jsxInject, include, exclude, ...esbuildTransformOptions } = options;

  const filter = createFilter(
    include || /\.(m?ts|[jt]sx)$/,
    exclude || /\.js$/
  );

  const transformOptions: TransformOptions = {
    target: "esnext",
    charset: "utf8",
    ...esbuildTransformOptions,
    minify: false,
    minifyIdentifiers: false,
    minifySyntax: false,
    minifyWhitespace: false,
    treeShaking: false,
    keepNames: false,
  };

  initTSConfck(config.root);

  return {
    name: "vite:esbuild",
    configureServer(_server) {
      server = _server;
      server.watcher
        .on("add", reloadOnTsconfigChange)
        .on("change", reloadOnTsconfigChange)
        .on("unlink", reloadOnTsconfigChange);
    },
    buildEnd() {
      server = null as any;
    },
    async transform(code, id) {
      if (filter(id) || filter(cleanUrl(id))) {
        const result = await transformWithEsbuild(code, id, transformOptions);
        if (result.warnings.length) {
          result.warnings.forEach((m) => {
            this.warn(prettifyMessage(m, code));
          });
        }
        if (jsxInject && jsxExtensionsRE.test(id)) {
          result.code = jsxInject + ";" + result.code;
        }
        return {
          code: result.code,
          map: result.map,
        };
      }
    },
  };
}

function initTSConfck(root: string, force = false) {
  if (!force && root === tsconfckRoot) return;

  const workspaceRoot = searchForWorkspaceRoot(root);

  tsconfckRoot = root;
  tsconfckParseOptions = initTSConfckParseOptions(workspaceRoot);

  tsconfckParseOptions.then((options) => {
    if (root === tsconfckRoot) {
      tsconfckParseOptions = options;
    }
  });
}

async function reloadOnTsconfigChange(changedFile: string) {
  if (!server) return;
  if (
    path.basename(changedFile) === "tsconfig.json" ||
    (changedFile.endsWith(".json") &&
      (await tsconfckParseOptions)?.cache?.has(changedFile))
  ) {
    server.config.logger.info(
      `changed tsconfig file detected: ${changedFile} - Clearing cache and forcing full-reload to ensure TypeScript is compiled with updated config values.`,
      { clear: server.config.clearScreen, timestamp: true }
    );

    server.moduleGraph.invalidateAll();

    initTSConfck(server.config.root, true);

    if (server) {
      server.ws.send({
        type: "full-reload",
        path: "*",
      });
    }
  }
}

export async function transformWithEsbuild(
  code: string,
  filename: string,
  options?: TransformOptions,
  inMap?: object
): Promise<ESBuildTransformResult> {
  let loader = options?.loader;

  if (!loader) {
    const ext = path
      .extname(validExtensionRE.test(filename) ? filename : cleanUrl(filename))
      .slice(1);

    if (ext === "cjs" || ext === "mjs") {
      loader = "js";
    } else if (ext === "cts" || ext === "mts") {
      loader = "ts";
    } else {
      loader = ext as Loader;
    }
  }

  let tsconfigRaw = options?.tsconfigRaw;

  if (typeof tsconfigRaw !== "string") {
    const meaningfulFields: Array<keyof TSCompilerOptions> = [
      "alwaysStrict",
      "importsNotUsedAsValues",
      "jsx",
      "jsxFactory",
      "jsxFragmentFactory",
      "jsxImportSource",
      "preserveValueImports",
      "target",
      "useDefineForClassFields",
    ];
    const compilerOptionsForFile: TSCompilerOptions = {};
    if (loader === "ts" || loader === "tsx") {
      const loadedTsconfig = await loadTsconfigJsonForFile(filename);
      const loadedCompilerOptions = loadedTsconfig.compilerOptions ?? {};

      for (const field of meaningfulFields) {
        if (field in loadedCompilerOptions) {
          // @ts-expect-error TypeScript can't tell they are of the same type
          compilerOptionsForFile[field] = loadedCompilerOptions[field];
        }
      }
    }

    const compilerOptions = {
      ...compilerOptionsForFile,
      ...tsconfigRaw?.compilerOptions,
    };

    if (compilerOptions.useDefineForClassFields === undefined) {
      const lowercaseTarget = compilerOptions.target?.toLowerCase() ?? "es3";
      if (lowercaseTarget.startsWith("es")) {
        const esVersion = lowercaseTarget.slice(2);
        compilerOptions.useDefineForClassFields =
          esVersion === "next" || +esVersion >= 2022;
      } else {
        compilerOptions.useDefineForClassFields = false;
      }
    }

    if (options) {
      options.jsx && (compilerOptions.jsx = undefined);
      options.jsxFactory && (compilerOptions.jsxFactory = undefined);
      options.jsxFragment && (compilerOptions.jsxFragmentFactory = undefined);
      options.jsxImportSource && (compilerOptions.jsxImportSource = undefined);
      options.target && (compilerOptions.target = undefined);
    }

    tsconfigRaw = {
      ...tsconfigRaw,
      compilerOptions,
    };
  }

  const resolvedOptions = {
    sourcemap: true,
    sourcefile: filename,
    ...options,
    loader,
    tsconfigRaw,
  } as ESBuildOptions;

  delete resolvedOptions.include;
  delete resolvedOptions.exclude;
  delete resolvedOptions.jsxInject;

  try {
    const result = await transform(code, resolvedOptions);
    let map: SourceMap;
    if (inMap && resolvedOptions.sourcemap) {
      const nextMap = JSON.parse(result.map);
      nextMap.sourcesContent = [];
      map = combineSourcemaps(filename, [
        nextMap as RawSourceMap,
        inMap as RawSourceMap,
      ]) as SourceMap;
    } else {
      map =
        resolvedOptions.sourcemap && resolvedOptions.sourcemap !== "inline"
          ? JSON.parse(result.map)
          : { mappings: "" };
    }
    return {
      ...result,
      map,
    };
  } catch (e: any) {
    debug?.(`esbuild error with options used: `, resolvedOptions);
    if (e.errors) {
      e.frame = "";
      e.errors.forEach((m: Message) => {
        e.frame += `\n` + prettifyMessage(m, code);
      });
      e.loc = e.errors[0].location;
    }
    throw e;
  }
}

function prettifyMessage(m: Message, code: string): string {
  let res = colors.yellow(m.text);
  if (m.location) {
    const lines = code.split(/\r?\n/g);
    const line = Number(m.location.line);
    const column = Number(m.location.column);
    const offset =
      lines
        .slice(0, line - 1)
        .map((l) => l.length)
        .reduce((total, l) => total + l + 1, 0) + column;
    res += `\n` + generateCodeFrame(code, offset, offset + 1);
  }
  return res + `\n`;
}

async function initTSConfckParseOptions(workspaceRoot: string) {
  const start = debug ? performance.now() : 0;

  const options: TSConfckParseOptions = {
    cache: new Map(),
    root: workspaceRoot,
    tsConfigPaths: new Set(
      await findAll(workspaceRoot, {
        skip: (dir) => dir === "node_modules" || dir === ".git",
      })
    ),
    resolveWithEmptyIfConfigNotFound: true,
  };

  debug?.(timeFrom(start), "tsconfck init", colors.dim(workspaceRoot));

  return options;
}

async function loadTsconfigJsonForFile(
  filename: string
): Promise<TSConfigJSON> {
  try {
    const result = await parse(filename, await tsconfckParseOptions);
    if (server && result.tsconfigFile !== "no_tsconfig_file_found") {
      ensureWatchedFile(
        server.watcher,
        result.tsconfigFile,
        server.config.root
      );
    }
    return result.tsconfig;
  } catch (e) {
    if (e instanceof TSConfckParseError) {
      if (server && e.tsconfigFile) {
        ensureWatchedFile(server.watcher, e.tsconfigFile, server.config.root);
      }
    }
    throw e;
  }
}

export function ensureWatchedFile(
  watcher: FSWatcher,
  file: string | null,
  root: string
): void {
  if (
    file &&
    // only need to watch if out of root
    !file.startsWith(root + "/") &&
    // some rollup plugins use null bytes for private resolved Ids
    !file.includes("\0") &&
    fs.existsSync(file)
  ) {
    // resolve file to normalized system path
    watcher.add(path.resolve(file));
  }
}
