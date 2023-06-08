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
  createFilter,
  generateCodeFrame,
} from "../utils";
import { ViteDevServer } from "../server";
import type { TSConfckParseOptions } from "tsconfck";
import type { SourceMap } from "rollup";
import { parse } from "tsconfck";
import { transform } from "esbuild";

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

let tsconfckParseOptions: TSConfckParseOptions | Promise<TSConfckParseOptions> =
  { resolveWithEmptyIfConfigNotFound: true };
// @ts-ignore
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

  return {
    name: "vite:esbuild",
    configureServer(_server) {},
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
/**使用 esbuild 将 JavaScript 或 TypeScript 模块进行转换*/
export async function transformWithEsbuild(
  code: string,
  filename: string,
  options?: TransformOptions
): Promise<ESBuildTransformResult> {
  let loader = options?.loader;

  if (!loader) {
    const ext = path
      .extname(validExtensionRE.test(filename) ? filename : cleanUrl(filename))
      .slice(1);
    loader = ext as Loader;
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
    // 判断处理文件是否是ts文件，是ts文件的话就读取tsconifg.json
    // 中的compilerOptions配置
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
    // config.build中的配置项存在时，就对compilerOptions
    // 中的配置项进行重置
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
    map =
      resolvedOptions.sourcemap && resolvedOptions.sourcemap !== "inline"
        ? JSON.parse(result.map)
        : { mappings: "" };
    return {
      ...result,
      map,
    };
  } catch (e: any) {
    throw new Error("transformWithEsbuild failed");
  }
}
/**打印警告信息 */
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
/**根据给定的文件路径，查找并加载与该文件相关联的 tsconfig.json 文件内容。 */
async function loadTsconfigJsonForFile(
  filename: string
): Promise<TSConfigJSON> {
  try {
    const result = await parse(filename, await tsconfckParseOptions);
    return result.tsconfig;
  } catch (e) {
    throw e;
  }
}
