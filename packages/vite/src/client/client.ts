import type { ErrorPayload, HMRPayload, Update } from "types/hmrPayload";
import type { ModuleNamespace, ViteHotContext } from "types/hot";
import type { InferCustomEventPayload } from "types/customEvent";
import { ErrorOverlay, overlayId } from "./overlay";
import "@vite/env";

declare const __BASE__: string;
declare const __SERVER_HOST__: string;
declare const __HMR_PROTOCOL__: string | null;
declare const __HMR_HOSTNAME__: string | null;
declare const __HMR_PORT__: number | null;
declare const __HMR_DIRECT_TARGET__: string;
declare const __HMR_BASE__: string;
declare const __HMR_TIMEOUT__: number;
declare const __HMR_ENABLE_OVERLAY__: boolean;

console.debug("[vite] connecting...");

const importMetaUrl = new URL(import.meta.url);

const serverHost = __SERVER_HOST__;
const socketProtocol =
  __HMR_PROTOCOL__ || (importMetaUrl.protocol === "https:" ? "wss" : "ws");
const hmrPort = __HMR_PORT__;
const socketHost = `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${
  hmrPort || importMetaUrl.port
}${__HMR_BASE__}`;
const directSocketHost = __HMR_DIRECT_TARGET__;
const base = __BASE__ || "/";
const messageBuffer: string[] = [];

let socket: WebSocket;
try {
  let fallback: (() => void) | undefined;
  if (!hmrPort) {
    fallback = () => {
      socket = setupWebSocket(socketProtocol, directSocketHost, () => {
        const currentScriptHostURL = new URL(import.meta.url);
        const currentScriptHost =
          currentScriptHostURL.host +
          currentScriptHostURL.pathname.replace(/@vite\/client$/, "");
        console.error(
          "[vite] failed to connect to websocket.\n" +
            "your current setup:\n" +
            `  (browser) ${currentScriptHost} <--[HTTP]--> ${serverHost} (server)\n` +
            `  (browser) ${socketHost} <--[WebSocket (failing)]--> ${directSocketHost} (server)\n` +
            "Check out your Vite / network configuration and https://vitejs.dev/config/server-options.html#server-hmr ."
        );
      });
      socket.addEventListener(
        "open",
        () => {
          console.info(
            "[vite] Direct websocket connection fallback. Check out https://vitejs.dev/config/server-options.html#server-hmr to remove the previous connection error."
          );
        },
        { once: true }
      );
    };
  }

  socket = setupWebSocket(socketProtocol, socketHost, fallback);
} catch (error) {
  console.error(`[vite] failed to connect to websocket (${error}). `);
}

function setupWebSocket(
  protocol: string,
  hostAndPath: string,
  onCloseWithoutOpen?: () => void
) {
  const socket = new WebSocket(`${protocol}://${hostAndPath}`, "vite-hmr");
  let isOpened = false;

  socket.addEventListener(
    "open",
    () => {
      isOpened = true;
    },
    { once: true }
  );

  socket.addEventListener("message", async ({ data }) => {
    handleMessage(JSON.parse(data));
  });

  socket.addEventListener("close", async ({ wasClean }) => {
    if (wasClean) return;

    if (!isOpened && onCloseWithoutOpen) {
      onCloseWithoutOpen();
      return;
    }

    console.log(`[vite] server connection lost. polling for restart...`);
    await waitForSuccessfulPing(protocol, hostAndPath);
    location.reload();
  });

  return socket;
}

function warnFailedFetch(err: Error, path: string | string[]) {
  if (!err.message.match("fetch")) {
    console.error(err);
  }
  console.error(
    `[hmr] Failed to reload ${path}. ` +
      `This could be due to syntax errors or importing non-existent ` +
      `modules. (see errors above)`
  );
}

function cleanUrl(pathname: string): string {
  const url = new URL(pathname, location.toString());
  url.searchParams.delete("direct");
  return url.pathname + url.search;
}

let isFirstUpdate = true;
// 失效的link元素
const outdatedLinkTags = new WeakSet<HTMLLinkElement>();

async function handleMessage(payload: HMRPayload) {
  switch (payload.type) {
    case "connected":
      console.debug(`[vite] connected.`);
      sendMessageBuffer();
      // 心跳检测
      setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send('{"type":"ping"}');
        }
      }, __HMR_TIMEOUT__);
      break;
    case "update":
      notifyListeners("vite:beforeUpdate", payload);
      // 如果是第一次更新或存在错误覆盖层
      // 则通过重新加载页面来刷新应用程序。
      if (isFirstUpdate && hasErrorOverlay()) {
        window.location.reload();
        return;
      } else {
        // 清除错误覆盖层
        // 并将isFirstUpdate设置为false
        clearErrorOverlay();
        isFirstUpdate = false;
      }
      await Promise.all(
        payload.updates.map(async (update): Promise<void> => {
          // 更新类型是 "js-update"的话
          if (update.type === "js-update") {
            // 添加到更新队列中进行更新
            return queueUpdate(fetchUpdate(update));
          }

          const { path, timestamp } = update;
          const searchUrl = cleanUrl(path);
          // 通过 href 匹配
          // 将其替换为新的<link>元素，以实现 CSS 的热更新效果
          const el = Array.from(
            document.querySelectorAll<HTMLLinkElement>("link")
          ).find(
            (e) =>
              !outdatedLinkTags.has(e) && cleanUrl(e.href).includes(searchUrl)
          );

          if (!el) {
            return;
          }

          const newPath = `${base}${searchUrl.slice(1)}${
            searchUrl.includes("?") ? "&" : "?"
          }t=${timestamp}`;

          return new Promise((resolve) => {
            // 设置其 href 属性为更新后的路径，
            const newLinkTag = el.cloneNode() as HTMLLinkElement;
            newLinkTag.href = new URL(newPath, el.href).href;
            // 移除el元素
            const removeOldEl = () => {
              el.remove();
              console.debug(`[vite] css hot updated: ${searchUrl}`);
              resolve();
            };
            // 监听新<link>元素的 "load" 和 "error" 事件，
            // 在加载完成后移除旧的<link>元素，
            newLinkTag.addEventListener("load", removeOldEl);
            newLinkTag.addEventListener("error", removeOldEl);
            outdatedLinkTags.add(el);
            // 同时将新<link>元素插入到旧的<link>元素后面
            el.after(newLinkTag);
          });
        })
      );
      notifyListeners("vite:afterUpdate", payload);
      break;
    case "custom": {
      notifyListeners(payload.event, payload.data);
      break;
    }
    case "full-reload":
      notifyListeners("vite:beforeFullReload", payload);
      if (payload.path && payload.path.endsWith(".html")) {
        const pagePath = decodeURI(location.pathname);
        const payloadPath = base + payload.path.slice(1);
        if (
          pagePath === payloadPath ||
          payload.path === "/index.html" ||
          (pagePath.endsWith("/") && pagePath + "index.html" === payloadPath)
        ) {
          location.reload();
        }
        return;
      } else {
        location.reload();
      }
      break;
    // 模块在页面上不被导入时触发
    case "prune":
      notifyListeners("vite:beforePrune", payload);
      payload.paths.forEach((path) => {
        const fn = pruneMap.get(path);
        if (fn) {
          fn(dataMap.get(path));
        }
      });
      break;
    case "error": {
      notifyListeners("vite:error", payload);
      const err = payload.err;
      if (enableOverlay) {
        createErrorOverlay(err);
      } else {
        console.error(
          `[vite] Internal Server Error\n${err.message}\n${err.stack}`
        );
      }
      break;
    }
    default: {
      const check: never = payload;
      return check;
    }
  }
}

function notifyListeners<T extends string>(
  event: T,
  data: InferCustomEventPayload<T>
): void;
function notifyListeners(event: string, data: any): void {
  const cbs = customListenersMap.get(event);
  if (cbs) {
    cbs.forEach((cb) => cb(data));
  }
}

const enableOverlay = __HMR_ENABLE_OVERLAY__;

function createErrorOverlay(err: ErrorPayload["err"]) {
  if (!enableOverlay) return;
  clearErrorOverlay();
  document.body.appendChild(new ErrorOverlay(err));
}

function clearErrorOverlay() {
  document
    .querySelectorAll(overlayId)
    .forEach((n) => (n as ErrorOverlay).close());
}

function hasErrorOverlay() {
  return document.querySelectorAll(overlayId).length;
}

let pending = false;
let queued: Promise<(() => void) | undefined>[] = [];

async function queueUpdate(p: Promise<(() => void) | undefined>) {
  queued.push(p);
  if (!pending) {
    pending = true;
    await Promise.resolve();
    pending = false;
    const loading = [...queued];
    queued = [];
    (await Promise.all(loading)).forEach((fn) => fn && fn());
  }
}

async function waitForSuccessfulPing(
  socketProtocol: string,
  hostAndPath: string,
  ms = 1000
) {
  const pingHostProtocol = socketProtocol === "wss" ? "https" : "http";

  const ping = async () => {
    try {
      await fetch(`${pingHostProtocol}://${hostAndPath}`, {
        mode: "no-cors",
        headers: {
          Accept: "text/x-vite-ping",
        },
      });
      return true;
    } catch (e) {}
    return false;
  };

  if (await ping()) {
    return;
  }
  await wait(ms);

  while (true) {
    if (document.visibilityState === "visible") {
      if (await ping()) {
        break;
      }
      await wait(ms);
    } else {
      await waitForWindowShow();
    }
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForWindowShow() {
  return new Promise<void>((resolve) => {
    const onChange = async () => {
      if (document.visibilityState === "visible") {
        resolve();
        document.removeEventListener("visibilitychange", onChange);
      }
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

const sheetsMap = new Map<string, HTMLStyleElement>();

if ("document" in globalThis) {
  document.querySelectorAll("style[data-vite-dev-id]").forEach((el) => {
    sheetsMap.set(el.getAttribute("data-vite-dev-id")!, el as HTMLStyleElement);
  });
}

let lastInsertedStyle: HTMLStyleElement | undefined;
/**
 * 根据给定的 id 查找对应的样式元素。
 * 如果找不到对应的样式元素，则会创建一个新的 <style> 元素
 */
export function updateStyle(id: string, content: string): void {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-vite-dev-id", id);
    style.textContent = content;

    if (!lastInsertedStyle) {
      document.head.appendChild(style);

      setTimeout(() => {
        lastInsertedStyle = undefined;
      }, 0);
    } else {
      lastInsertedStyle.insertAdjacentElement("afterend", style);
    }
    lastInsertedStyle = style;
  } else {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}

export function removeStyle(id: string): void {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}

async function fetchUpdate({
  path,
  acceptedPath,
  timestamp,
  explicitImportRequired,
}: Update) {
  // 获取需要热更新相应的模块对象
  const mod = hotModulesMap.get(path);
  if (!mod) {
    return;
  }

  let fetchedModule: ModuleNamespace | undefined;
  // 判断是否为自身更新
  const isSelfUpdate = path === acceptedPath;
  // 模快中符合条件的回调函数
  const qualifiedCallbacks = mod.callbacks.filter(({ deps }) =>
    deps.includes(acceptedPath)
  );

  if (isSelfUpdate || qualifiedCallbacks.length > 0) {
    // 检查是否存在之前的清理器
    const disposer = disposeMap.get(acceptedPath);
    // 如果存在，则调用清理器进行清理操作。
    if (disposer) await disposer(dataMap.get(acceptedPath));
    const [acceptedPathWithoutQuery, query] = acceptedPath.split(`?`);
    try {
      // 使用import语法获取更新后的模块内容
      fetchedModule = await import(
        base +
          acceptedPathWithoutQuery.slice(1) +
          `?${explicitImportRequired ? "import&" : ""}t=${timestamp}${
            query ? `&${query}` : ""
          }`
      );
    } catch (e) {
      warnFailedFetch(e, acceptedPath);
    }
  }

  return () => {
    // 遍历符合条件的回调函数列表（qualifiedCallbacks），
    for (const { deps, fn } of qualifiedCallbacks) {
      // 并调用每个回调函数，传递更新模块的内容作为参数
      fn(deps.map((dep) => (dep === acceptedPath ? fetchedModule : undefined)));
    }
    const loggedPath = isSelfUpdate ? path : `${acceptedPath} via ${path}`;
    console.debug(`[vite] hot updated: ${loggedPath}`);
  };
}

function sendMessageBuffer() {
  // socket.readyState为1时,表示 WebSocket 连接已经建立并且可用。
  if (socket.readyState === 1) {
    messageBuffer.forEach((msg) => socket.send(msg));
    // 清空消息，表示所有的消息都已经成功发送。
    messageBuffer.length = 0;
  }
}

interface HotModule {
  id: string;
  callbacks: HotCallback[];
}

interface HotCallback {
  deps: string[];
  fn: (modules: Array<ModuleNamespace | undefined>) => void;
}

type CustomListenersMap = Map<string, ((data: any) => void)[]>;

const hotModulesMap = new Map<string, HotModule>();
const disposeMap = new Map<string, (data: any) => void | Promise<void>>();
// 存储在页面上不再被导入的模块
const pruneMap = new Map<string, (data: any) => void | Promise<void>>();
const dataMap = new Map<string, any>();
// 存储自定义事件监听器
const customListenersMap: CustomListenersMap = new Map();
const ctxToListenersMap = new Map<string, CustomListenersMap>();

export function createHotContext(ownerPath: string): ViteHotContext {
  if (!dataMap.has(ownerPath)) {
    dataMap.set(ownerPath, {});
  }

  const mod = hotModulesMap.get(ownerPath);
  if (mod) {
    mod.callbacks = [];
  }

  const staleListeners = ctxToListenersMap.get(ownerPath);
  if (staleListeners) {
    for (const [event, staleFns] of staleListeners) {
      const listeners = customListenersMap.get(event);
      if (listeners) {
        customListenersMap.set(
          event,
          listeners.filter((l) => !staleFns.includes(l))
        );
      }
    }
  }

  const newListeners: CustomListenersMap = new Map();
  ctxToListenersMap.set(ownerPath, newListeners);
  // 将当前模块的接收模块信息和更新回调存储到hotModulesMap
  function acceptDeps(deps: string[], callback: HotCallback["fn"] = () => {}) {
    const mod: HotModule = hotModulesMap.get(ownerPath) || {
      id: ownerPath,
      callbacks: [],
    };
    mod.callbacks.push({
      deps,
      fn: callback,
    });
    hotModulesMap.set(ownerPath, mod);
  }
  // import.meta.hot多种方法的实现
  const hot: ViteHotContext = {
    get data() {
      return dataMap.get(ownerPath);
    },

    accept(deps?: any, callback?: any) {
      if (typeof deps === "function" || !deps) {
        acceptDeps([ownerPath], ([mod]) => deps?.(mod));
      } else if (typeof deps === "string") {
        acceptDeps([deps], ([mod]) => callback?.(mod));
      } else if (Array.isArray(deps)) {
        acceptDeps(deps, callback);
      } else {
        throw new Error(`invalid hot.accept() usage.`);
      }
    },

    acceptExports(_, callback) {
      acceptDeps([ownerPath], ([mod]) => callback?.(mod));
    },
    // 当一个模块需要更新时，旧模块的状态可能需要被清理，
    // 以避免与更新后的模块状态冲突或产生副作用
    // 通过调用 dispose(cb)，可以将清理器函数与对应的模块路径关联起来，
    // 以便在更新模块之前执行清理操作
    // 清理器函数 cb 可以是一个异步函数，
    dispose(cb) {
      disposeMap.set(ownerPath, cb);
    },

    prune(cb) {
      pruneMap.set(ownerPath, cb);
    },

    // @ts-expect-error untyped
    decline() {},

    invalidate(message) {
      notifyListeners("vite:invalidate", { path: ownerPath, message });
      this.send("vite:invalidate", { path: ownerPath, message });
      console.debug(
        `[vite] invalidate ${ownerPath}${message ? `: ${message}` : ""}`
      );
    },

    on(event, cb) {
      const addToMap = (map: Map<string, any[]>) => {
        const existing = map.get(event) || [];
        existing.push(cb);
        map.set(event, existing);
      };
      addToMap(customListenersMap);
      addToMap(newListeners);
    },

    send(event, data) {
      messageBuffer.push(JSON.stringify({ type: "custom", event, data }));
      sendMessageBuffer();
    },
  };

  return hot;
}

export function injectQuery(url: string, queryToInject: string): string {
  if (url[0] !== "." && url[0] !== "/") {
    return url;
  }

  const pathname = url.replace(/#.*$/, "").replace(/\?.*$/, "");
  const { search, hash } = new URL(url, "http://vitejs.dev");

  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ""}${
    hash || ""
  }`;
}

export { ErrorOverlay };
