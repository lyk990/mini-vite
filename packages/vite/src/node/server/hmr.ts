import { ViteDevServer } from ".";
import { createDebugger, normalizePath, unique, wrapId } from "../utils";
import path from "node:path";
import colors from "picocolors";
import { CLIENT_DIR } from "../constants";
import { HmrContext, isCSSRequest, ModuleNode } from "vite";
import fsp from "node:fs/promises";
import type { Update } from "types/hmrPayload";
import { isExplicitImportRequired } from "../plugins/importAnalysis";
import { getAffectedGlobModules } from "../plugins/importMetaGlob";
import type { RollupError } from "rollup";

export function getShortName(file: string, root: string): string {
  return file.startsWith(root + "/") ? path.posix.relative(root, file) : file;
}
export const debugHmr = createDebugger("vite:hmr");
const normalizedClientDir = normalizePath(CLIENT_DIR);
/**处理热更新 */
export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer,
  configOnly: boolean
): Promise<void> {
  const { ws, config, moduleGraph } = server;
  const shortFile = getShortName(file, config.root);

  if (configOnly) {
    return;
  }

  debugHmr?.(`[file change] ${colors.dim(shortFile)}`);
  // client脚本文件发生更改时
  // 通知浏览器重新reload,刷新页面
  if (file.startsWith(normalizedClientDir)) {
    ws.send({
      type: "full-reload",
      path: "*",
    });
    return;
  }
  // 获取文件变动的具体路径
  const mods = moduleGraph.getModulesByFile(file);

  const timestamp = Date.now();
  // 初始化HMR上下文对象
  const hmrContext: HmrContext = {
    file,
    timestamp,
    modules: mods ? [...mods] : [],
    // 使用utf-8格式读取文件内容
    read: () => readModifiedFile(file),
    server: server as any,
  };

  for (const hook of config.getSortedPluginHooks("handleHotUpdate")) {
    const filteredModules = await hook(hmrContext);
    if (filteredModules) {
      hmrContext.modules = filteredModules;
    }
  }
  // 更新热更新模块信息,同时给浏览器推送信息
  updateModules(shortFile, hmrContext.modules, timestamp, server);
}

/**给浏览器端推送消息 */
export function updateModules(
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  { config, ws, moduleGraph }: ViteDevServer,
  afterInvalidation?: boolean
): void {
  // 存储更新的信息
  const updates: Update[] = [];
  // 失效的模块集合
  const invalidatedModules = new Set<ModuleNode>();
  // 被遍历过的模块集合
  const traversedModules = new Set<ModuleNode>();
  // 页面是否需要重新reload
  let needFullReload = false;

  for (const mod of modules) {
    // 将需要更新的模块标记为失效状态
    // 只有被标记为失效的模块才会被处理和更新，减少了不必要的计算和传播。
    moduleGraph.invalidateModule(mod, invalidatedModules, timestamp, true);
    if (needFullReload) {
      continue;
    }
    // 收集边界模块和接受更新的模块。如果遇到了没有接受更新的模块,
    const boundaries: { boundary: ModuleNode; acceptedVia: ModuleNode }[] = [];
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries);
    if (hasDeadEnd) {
      // 则将 needFullReload 标记为 true，并跳过当前模块的处理
      needFullReload = true;
      continue;
    }
    // 将每个边界模块和接受更新的模块
    updates.push(
      ...boundaries.map(({ boundary, acceptedVia }) => ({
        type: `${boundary.type}-update` as const,
        timestamp,
        path: normalizeHmrUrl(boundary.url),
        explicitImportRequired:
          boundary.type === "js"
            ? isExplicitImportRequired(acceptedVia.url)
            : undefined,
        acceptedPath: normalizeHmrUrl(acceptedVia.url),
      }))
    );
  }
  // 如果 needFullReload 为 true，表示页面需要重新加载。
  // 会向客户端发送一个类型为 "full-reload" 的消息
  if (needFullReload) {
    config.logger.info(colors.green(`page reload `) + colors.dim(file), {
      clear: !afterInvalidation,
      timestamp: true,
    });
    ws.send({
      type: "full-reload",
    });
    return;
  }
  // 表示没有更新
  if (updates.length === 0) {
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file));
    return;
  }
  // 如果有更新信息，它会通过日志输出显示更新的信息，
  // 并将更新消息发送给客户端
  config.logger.info(
    colors.green(`hmr update `) +
      colors.dim([...new Set(updates.map((u) => u.path))].join(", ")),
    { clear: !afterInvalidation, timestamp: true }
  );
  ws.send({
    type: "update",
    updates,
  });
}

export async function handleFileAddUnlink(
  file: string,
  server: ViteDevServer
): Promise<void> {
  const modules = [...(server.moduleGraph.getModulesByFile(file) || [])];

  modules.push(...getAffectedGlobModules(file, server));

  if (modules.length > 0) {
    updateModules(
      getShortName(file, server.config.root),
      unique(modules),
      Date.now(),
      server
    );
  }
}
/**
 * 读取文件内容,如果文件内容为空，
 * 意味着文件可能正在被写入，此时函数会进入等待状态，持续轮询文件的最后修改时间，
 * 直到文件内容不为空或达到最大轮询次数
 */
async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, "utf-8");
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs;
    await new Promise((r) => {
      let n = 0;
      const poll = async () => {
        n++;
        const newMtime = (await fsp.stat(file)).mtimeMs;
        if (newMtime !== mtime || n > 10) {
          r(0);
        } else {
          setTimeout(poll, 10);
        }
      };
      setTimeout(poll, 10);
    });
    return await fsp.readFile(file, "utf-8");
  } else {
    return content;
  }
}
/**根据模块之间的依赖关系,找到热更新边界 */
function propagateUpdate(
  node: ModuleNode,
  traversedModules: Set<ModuleNode>,
  boundaries: { boundary: ModuleNode; acceptedVia: ModuleNode }[],
  currentChain: ModuleNode[] = [node]
): boolean /* hasDeadEnd */ {
  // 当前模块是否已经被遍历过了
  // 遍历过了就无需再被遍历
  if (traversedModules.has(node)) {
    return false;
  }
  traversedModules.add(node);
  // 判断模块是否已经被分析过，如果未被分析过，则返回
  // 当模块未被分析时，模块是否能够接受自身的热更新
  // false代表没找到热更新边界
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id
      )}`
    );
    return false;
  }

  if (node.isSelfAccepting) {
    // 添加到热更新边界列表中
    boundaries.push({ boundary: node, acceptedVia: node });

    for (const importer of node.importers) {
      // TODO 为什么需要判断是不是css请求
      // 是 CSS 请求且不在热更新传播链中，
      // 则递归调用 propagateUpdate 来传播更新，同时将导入者添加到当前链中
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        propagateUpdate(
          importer,
          traversedModules,
          boundaries,
          currentChain.concat(importer)
        );
      }
    }
  }
  return false;
}
/**规范hmr文件路径 */
export function normalizeHmrUrl(url: string): string {
  if (url[0] !== "." && url[0] !== "/") {
    url = wrapId(url);
  }
  return url;
}

function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
      `Array of string literals.`
  ) as RollupError;
  err.pos = pos;
  throw err;
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray,
}
const whitespaceRE = /\s/;
// TODO AST是怎么解析的
/**对热更新依赖模块进行处理 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>
): boolean {
  let state: LexerState = LexerState.inCall;
  let prevState: LexerState = LexerState.inCall;
  let currentDep: string = "";

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1,
    });
    currentDep = "";
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i);
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state;
          state = LexerState.inSingleQuoteString;
        } else if (char === `"`) {
          prevState = state;
          state = LexerState.inDoubleQuoteString;
        } else if (char === "`") {
          prevState = state;
          state = LexerState.inTemplateString;
        } else if (whitespaceRE.test(char)) {
          continue;
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray;
            } else {
              return true;
            }
          } else if (state === LexerState.inArray) {
            if (char === `]`) {
              return false;
            } else if (char === ",") {
              continue;
            } else {
              error(i);
            }
          }
        }
        break;
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i);
          if (prevState === LexerState.inCall) {
            return false;
          } else {
            state = prevState;
          }
        } else {
          currentDep += char;
        }
        break;
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i);
          if (prevState === LexerState.inCall) {
            return false;
          } else {
            state = prevState;
          }
        } else {
          currentDep += char;
        }
        break;
      case LexerState.inTemplateString:
        if (char === "`") {
          addDep(i);
          if (prevState === LexerState.inCall) {
            return false;
          } else {
            state = prevState;
          }
        } else if (char === "$" && code.charAt(i + 1) === "{") {
          error(i);
        } else {
          currentDep += char;
        }
        break;
      default:
        throw new Error("unknown import.meta.hot lexer state");
    }
  }
  return false;
}
