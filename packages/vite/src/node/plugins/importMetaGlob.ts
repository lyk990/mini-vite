import { ModuleNode } from "vite";
import { ViteDevServer } from "../server";
import micromatch from "micromatch";
import type { GeneralImportGlobOptions } from "types/importGlob";
import MagicString from "magic-string";
import { evalValue, normalizePath, slash } from "../utils";
import { isAbsolute, posix } from "node:path";
import { stripLiteral } from "strip-literal";
import type {
  ArrayExpression,
  CallExpression,
  Expression,
  Literal,
  MemberExpression,
  Node,
  SequenceExpression,
  SpreadElement,
  TemplateLiteral,
} from "estree";
import { parseExpressionAt } from "acorn";
import { findNodeAt } from "acorn-walk";
import fg from "fast-glob";
import { stringifyQuery } from "ufo";
import { isCSSRequest, isModuleCSSRequest } from "./css";
import type { RollupError } from "rollup";

export interface ParsedImportGlob {
  match: RegExpMatchArray;
  index: number;
  globs: string[];
  globsResolved: string[];
  isRelative: boolean;
  options: GeneralImportGlobOptions;
  type: string;
  start: number;
  end: number;
}

export interface TransformGlobImportResult {
  s: MagicString;
  matches: ParsedImportGlob[];
  files: Set<string>;
}

type IdResolver = (
  id: string,
  importer?: string
) => Promise<string | undefined> | string | undefined;

const { isMatch, scan } = micromatch;

const { basename, dirname, relative, join } = posix;
const importPrefix = "__vite_glob_";
const importGlobRE =
  /\bimport\.meta\.(glob|globEager|globEagerDefault)(?:<\w+>)?\s*\(/g;
const forceDefaultAs = ["raw", "url"];
const knownOptions = {
  as: ["string"],
  eager: ["boolean"],
  import: ["string"],
  exhaustive: ["boolean"],
  query: ["object", "string"],
};

const warnedCSSDefaultImportVarName = "__vite_warned_css_default_import";
const jsonStringifyInOneline = (input: any) =>
  JSON.stringify(input).replace(/[{,:]/g, "$& ").replace(/\}/g, " }");
const createCssDefaultImportWarning = (
  globs: string[],
  options: GeneralImportGlobOptions
) =>
  `if (!${warnedCSSDefaultImportVarName}) {` +
  `${warnedCSSDefaultImportVarName} = true;` +
  `console.warn(${JSON.stringify(
    "Default import of CSS without `?inline` is deprecated. " +
      "Add the `{ query: '?inline' }` glob option to fix this.\n" +
      `For example: \`import.meta.glob(${jsonStringifyInOneline(
        globs.length === 1 ? globs[0] : globs
      )}, ${jsonStringifyInOneline({ ...options, query: "?inline" })})\``
  )});` +
  `}`;

function err(e: string, pos: number) {
  const error = new Error(e) as RollupError;
  error.pos = pos;
  return error;
}

function globSafePath(path: string) {
  return fg.escapePath(normalizePath(path));
}

function lastNthChar(str: string, n: number) {
  return str.charAt(str.length - 1 - n);
}

function globSafeResolvedPath(resolved: string, glob: string) {
  let numEqual = 0;
  const maxEqual = Math.min(resolved.length, glob.length);
  while (
    numEqual < maxEqual &&
    lastNthChar(resolved, numEqual) === lastNthChar(glob, numEqual)
  ) {
    numEqual += 1;
  }
  const staticPartEnd = resolved.length - numEqual;
  const staticPart = resolved.slice(0, staticPartEnd);
  const dynamicPart = resolved.slice(staticPartEnd);
  return globSafePath(staticPart) + dynamicPart;
}

export async function parseImportGlob(
  code: string,
  importer: string | undefined,
  root: string,
  resolveId: IdResolver
): Promise<ParsedImportGlob[]> {
  let cleanCode;
  try {
    cleanCode = stripLiteral(code);
  } catch (e) {
    return [];
  }
  const matches = Array.from(cleanCode.matchAll(importGlobRE));

  const tasks = matches.map(async (match, index) => {
    const type = match[1];
    const start = match.index!;

    const err = (msg: string) => {
      const e = new Error(`Invalid glob import syntax: ${msg}`);
      (e as any).pos = start;
      return e;
    };

    let ast: CallExpression | SequenceExpression | MemberExpression;
    let lastTokenPos: number | undefined;

    try {
      ast = parseExpressionAt(code, start, {
        ecmaVersion: "latest",
        sourceType: "module",
        ranges: true,
        onToken: (token) => {
          lastTokenPos = token.end;
        },
      }) as any;
    } catch (e) {
      const _e = e as any;
      if (_e.message && _e.message.startsWith("Unterminated string constant"))
        return undefined!;
      if (lastTokenPos == null || lastTokenPos <= start) throw _e;

      try {
        const statement = code
          .slice(start, lastTokenPos)
          .replace(/[,\s]*$/, "");
        ast = parseExpressionAt(" ".repeat(start) + statement, start, {
          ecmaVersion: "latest",
          sourceType: "module",
          ranges: true,
        }) as any;
      } catch (e) {
        throw _e;
      }
    }

    const found = findNodeAt(ast as any, start, undefined, "CallExpression");
    if (!found) throw err(`Expect CallExpression, got ${ast.type}`);
    ast = found.node as unknown as CallExpression;

    if (ast.arguments.length < 1 || ast.arguments.length > 2)
      throw err(`Expected 1-2 arguments, but got ${ast.arguments.length}`);

    const arg1 = ast.arguments[0] as
      | ArrayExpression
      | Literal
      | TemplateLiteral;
    const arg2 = ast.arguments[1] as Node | undefined;

    const globs: string[] = [];

    const validateLiteral = (element: Expression | SpreadElement | null) => {
      if (!element) return;
      if (element.type === "Literal") {
        if (typeof element.value !== "string")
          throw err(
            `Expected glob to be a string, but got "${typeof element.value}"`
          );
        globs.push(element.value);
      } else if (element.type === "TemplateLiteral") {
        if (element.expressions.length !== 0) {
          throw err(
            `Expected glob to be a string, but got dynamic template literal`
          );
        }
        globs.push(element.quasis[0].value.raw);
      } else {
        throw err("Could only use literals");
      }
    };

    if (arg1.type === "ArrayExpression") {
      for (const element of arg1.elements) {
        validateLiteral(element);
      }
    } else {
      validateLiteral(arg1);
    }

    let options: GeneralImportGlobOptions = {};
    if (arg2) {
      if (arg2.type !== "ObjectExpression")
        throw err(
          `Expected the second argument to be an object literal, but got "${arg2.type}"`
        );

      options = parseGlobOptions(
        code.slice(arg2.range![0], arg2.range![1]),
        arg2.range![0]
      );
    }

    const end = ast.range![1];

    const globsResolved = await Promise.all(
      globs.map((glob) => toAbsoluteGlob(glob, root, importer, resolveId))
    );
    const isRelative = globs.every((i) => ".!".includes(i[0]));

    return {
      match,
      index,
      globs,
      globsResolved,
      isRelative,
      options,
      type,
      start,
      end,
    };
  });

  return (await Promise.all(tasks)).filter(Boolean);
}
/**获取受影响的hmr模块 */
export function getAffectedGlobModules(
  file: string,
  server: ViteDevServer
): ModuleNode[] {
  const modules: ModuleNode[] = [];
  for (const [id, allGlobs] of server._importGlobMap!) {
    if (allGlobs.some((glob) => isMatch(file, glob)))
      modules.push(...(server.moduleGraph.getModulesByFile(id) || []));
  }
  modules.forEach((i) => {
    if (i?.file) server.moduleGraph.onFileChange(i.file);
  });
  return modules;
}

export async function transformGlobImport(
  code: string,
  id: string,
  root: string,
  resolveId: IdResolver,
  restoreQueryExtension = false
): Promise<TransformGlobImportResult | null> {
  id = slash(id);
  root = slash(root);
  const isVirtual = isVirtualModule(id);
  const dir = isVirtual ? undefined : dirname(id);
  const matches = await parseImportGlob(
    code,
    isVirtual ? undefined : id,
    root,
    resolveId
  );
  const matchedFiles = new Set<string>();

  // TODO: backwards compatibility
  matches.forEach((i) => {
    if (i.type === "globEager") i.options.eager = true;
    if (i.type === "globEagerDefault") {
      i.options.eager = true;
      i.options.import = "default";
    }
  });

  if (!matches.length) return null;

  const s = new MagicString(code);

  const staticImports = (
    await Promise.all(
      matches.map(
        async ({
          globs,
          globsResolved,
          isRelative,
          options,
          index,
          start,
          end,
        }) => {
          const cwd = getCommonBase(globsResolved) ?? root;
          const files = (
            await fg(globsResolved, {
              cwd,
              absolute: true,
              dot: !!options.exhaustive,
              ignore: options.exhaustive
                ? []
                : [join(cwd, "**/node_modules/**")],
            })
          )
            .filter((file) => file !== id)
            .sort();

          const objectProps: string[] = [];
          const staticImports: string[] = [];

          let query = !options.query
            ? ""
            : typeof options.query === "string"
            ? options.query
            : stringifyQuery(options.query as any);

          if (query && query[0] !== "?") query = `?${query}`;

          const resolvePaths = (file: string) => {
            if (!dir) {
              if (isRelative)
                throw new Error(
                  "In virtual modules, all globs must start with '/'"
                );
              const filePath = `/${relative(root, file)}`;
              return { filePath, importPath: filePath };
            }

            let importPath = relative(dir, file);
            if (importPath[0] !== ".") importPath = `./${importPath}`;

            let filePath: string;
            if (isRelative) {
              filePath = importPath;
            } else {
              filePath = relative(root, file);
              if (filePath[0] !== ".") filePath = `/${filePath}`;
            }

            return { filePath, importPath };
          };

          let includesCSS = false;
          files.forEach((file, i) => {
            const paths = resolvePaths(file);
            const filePath = paths.filePath;
            let importPath = paths.importPath;
            let importQuery = query;

            if (importQuery && importQuery !== "?raw") {
              const fileExtension = basename(file).split(".").slice(-1)[0];
              if (fileExtension && restoreQueryExtension)
                importQuery = `${importQuery}&lang.${fileExtension}`;
            }

            importPath = `${importPath}${importQuery}`;

            const isCSS =
              !query && isCSSRequest(file) && !isModuleCSSRequest(file);
            includesCSS ||= isCSS;

            const importKey =
              options.import && options.import !== "*"
                ? options.import
                : undefined;

            if (options.eager) {
              const variableName = `${importPrefix}${index}_${i}`;
              const expression = importKey
                ? `{ ${importKey} as ${variableName} }`
                : `* as ${variableName}`;
              staticImports.push(
                `import ${expression} from ${JSON.stringify(importPath)}`
              );
              if (isCSS) {
                objectProps.push(
                  `get ${JSON.stringify(
                    filePath
                  )}() { ${createCssDefaultImportWarning(
                    globs,
                    options
                  )} return ${variableName} }`
                );
              } else {
                objectProps.push(
                  `${JSON.stringify(filePath)}: ${variableName}`
                );
              }
            } else {
              let importStatement = `import(${JSON.stringify(importPath)})`;
              if (importKey)
                importStatement += `.then(m => m[${JSON.stringify(
                  importKey
                )}])`;
              if (isCSS) {
                objectProps.push(
                  `${JSON.stringify(
                    filePath
                  )}: () => { ${createCssDefaultImportWarning(
                    globs,
                    options
                  )} return ${importStatement}}`
                );
              } else {
                objectProps.push(
                  `${JSON.stringify(filePath)}: () => ${importStatement}`
                );
              }
            }
          });

          files.forEach((i) => matchedFiles.add(i));

          const originalLineBreakCount =
            code.slice(start, end).match(/\n/g)?.length ?? 0;
          const lineBreaks =
            originalLineBreakCount > 0
              ? "\n".repeat(originalLineBreakCount)
              : "";

          let replacement: string;
          if (includesCSS) {
            replacement =
              "/* #__PURE__ */ Object.assign(" +
              "(() => {" +
              `let ${warnedCSSDefaultImportVarName} = false;` +
              `return {${objectProps.join(",")}${lineBreaks}};` +
              "})()" +
              ")";
          } else {
            replacement = `/* #__PURE__ */ Object.assign({${objectProps.join(
              ","
            )}${lineBreaks}})`;
          }
          s.overwrite(start, end, replacement);

          return staticImports;
        }
      )
    )
  ).flat();

  if (staticImports.length) s.prepend(`${staticImports.join(";")};`);

  return {
    s,
    matches,
    files: matchedFiles,
  };
}

export function isVirtualModule(id: string): boolean {
  return id.startsWith("virtual:") || id[0] === "\0" || !id.includes("/");
}

function parseGlobOptions(
  rawOpts: string,
  optsStartIndex: number
): GeneralImportGlobOptions {
  let opts: GeneralImportGlobOptions = {};
  try {
    opts = evalValue(rawOpts);
  } catch (e) {
    throw err(
      "Vite is unable to parse the glob options as the value is not static",
      optsStartIndex
    );
  }

  if (opts == null) {
    return {};
  }

  for (const key in opts) {
    if (!(key in knownOptions)) {
      throw err(`Unknown glob option "${key}"`, optsStartIndex);
    }
    const allowedTypes = knownOptions[key as keyof typeof knownOptions];
    const valueType = typeof opts[key as keyof GeneralImportGlobOptions];
    if (!allowedTypes.includes(valueType)) {
      throw err(
        `Expected glob option "${key}" to be of type ${allowedTypes.join(
          " or "
        )}, but got ${valueType}`,
        optsStartIndex
      );
    }
  }

  if (typeof opts.query === "object") {
    for (const key in opts.query) {
      const value = opts.query[key];
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw err(
          `Expected glob option "query.${key}" to be of type string, number, or boolean, but got ${typeof value}`,
          optsStartIndex
        );
      }
    }
  }

  if (opts.as && forceDefaultAs.includes(opts.as)) {
    if (opts.import && opts.import !== "default" && opts.import !== "*")
      throw err(
        `Option "import" can only be "default" or "*" when "as" is "${opts.as}", but got "${opts.import}"`,
        optsStartIndex
      );
    opts.import = opts.import || "default";
  }

  if (opts.as && opts.query)
    throw err(
      'Options "as" and "query" cannot be used together',
      optsStartIndex
    );

  if (opts.as) opts.query = opts.as;

  return opts;
}

export async function toAbsoluteGlob(
  glob: string,
  root: string,
  importer: string | undefined,
  resolveId: IdResolver
): Promise<string> {
  let pre = "";
  if (glob[0] === "!") {
    pre = "!";
    glob = glob.slice(1);
  }
  root = globSafePath(root);
  const dir = importer ? globSafePath(dirname(importer)) : root;
  if (glob[0] === "/") return pre + posix.join(root, glob.slice(1));
  if (glob.startsWith("./")) return pre + posix.join(dir, glob.slice(2));
  if (glob.startsWith("../")) return pre + posix.join(dir, glob);
  if (glob.startsWith("**")) return pre + glob;

  const resolved = normalizePath((await resolveId(glob, importer)) || glob);
  if (isAbsolute(resolved)) {
    return pre + globSafeResolvedPath(resolved, glob);
  }

  throw new Error(
    `Invalid glob: "${glob}" (resolved: "${resolved}"). It must start with '/' or './'`
  );
}

export function getCommonBase(globsResolved: string[]): null | string {
  const bases = globsResolved
    .filter((g) => g[0] !== "!")
    .map((glob) => {
      let { base } = scan(glob);
      if (posix.basename(base).includes(".")) base = posix.dirname(base);

      return base;
    });

  if (!bases.length) return null;

  let commonAncestor = "";
  const dirS = bases[0].split("/");
  for (let i = 0; i < dirS.length; i++) {
    const candidate = dirS.slice(0, i + 1).join("/");
    if (bases.every((base) => base.startsWith(candidate)))
      commonAncestor = candidate;
    else break;
  }
  if (!commonAncestor) commonAncestor = "/";

  return commonAncestor;
}
