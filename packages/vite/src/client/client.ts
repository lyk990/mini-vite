import type { ErrorPayload, HMRPayload, Update } from "types/hmrPayload";
import type { InferCustomEventPayload } from "types/customEvent";
import { ErrorOverlay, overlayId } from "./overlay";
import type {
  ModuleNamespace,
  ViteHotContext,
  ViteHotContext as _ViteHotContext,
} from "types/hot";

const importMetaUrl = new URL(import.meta.url);
interface HotModule {
  id: string;
  callbacks: HotCallback[];
}
interface HotCallback {
  deps: string[];
  fn: (modules: Array<ModuleNamespace | undefined>) => void;
}
declare const __BASE__: string;
declare const __HMR_PROTOCOL__: string | null;
declare const __HMR_PORT__: number | null;
declare const __HMR_DIRECT_TARGET__: string;
declare const __SERVER_HOST__: string;
declare const __HMR_HOSTNAME__: string | null;
declare const __HMR_BASE__: string;
declare const __HMR_TIMEOUT__: number;
declare const __HMR_ENABLE_OVERLAY__: boolean;

const pruneMap = new Map<string, (data: any) => void | Promise<void>>();
const dataMap = new Map<string, any>();
const base = __BASE__ || "/";
const enableOverlay = __HMR_ENABLE_OVERLAY__;
const ctxToListenersMap = new Map<string, CustomListenersMap>();

const messageBuffer: string[] = [];
const outdatedLinkTags = new WeakSet<HTMLLinkElement>();

const serverHost = __SERVER_HOST__;
const hmrPort = __HMR_PORT__;
const socketProtocol =
  __HMR_PROTOCOL__ || (importMetaUrl.protocol === "https:" ? "wss" : "ws");
const directSocketHost = __HMR_DIRECT_TARGET__;
const hotModulesMap = new Map<string, HotModule>();

const socketHost = `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${
  hmrPort || importMetaUrl.port
}${__HMR_BASE__}`;
let socket: WebSocket;
let isFirstUpdate = true;

type CustomListenersMap = Map<string, ((data: any) => void)[]>;
const customListenersMap: CustomListenersMap = new Map();
const disposeMap = new Map<string, (data: any) => void | Promise<void>>();

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

  // Listen for messages
  socket.addEventListener("message", async ({ data }) => {
    handleMessage(JSON.parse(data));
  });

  // ping server
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

async function handleMessage(payload: HMRPayload) {
  switch (payload.type) {
    case "connected":
      console.debug(`[vite] connected.`);
      sendMessageBuffer();
      setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send('{"type":"ping"}');
        }
      }, __HMR_TIMEOUT__);
      break;
    case "update":
      notifyListeners("vite:beforeUpdate", payload);
      if (isFirstUpdate && hasErrorOverlay()) {
        window.location.reload();
        return;
      } else {
        clearErrorOverlay();
        isFirstUpdate = false;
      }
      await Promise.all(
        payload.updates.map(async (update): Promise<void> => {
          if (update.type === "js-update") {
            return queueUpdate(fetchUpdate(update));
          }

          const { path, timestamp } = update;
          const searchUrl = cleanUrl(path);

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
            const newLinkTag = el.cloneNode() as HTMLLinkElement;
            newLinkTag.href = new URL(newPath, el.href).href;
            const removeOldEl = () => {
              el.remove();
              console.debug(`[vite] css hot updated: ${searchUrl}`);
              resolve();
            };
            newLinkTag.addEventListener("load", removeOldEl);
            newLinkTag.addEventListener("error", removeOldEl);
            outdatedLinkTags.add(el);
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
      });
      return true;
    } catch {}
    return false;
  };

  if (await ping()) {
    return;
  }
  await wait(ms);

  // eslint-disable-next-line no-constant-condition
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

function sendMessageBuffer() {
  if (socket.readyState === 1) {
    messageBuffer.forEach((msg) => socket.send(msg));
    messageBuffer.length = 0;
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

function hasErrorOverlay() {
  return document.querySelectorAll(overlayId).length;
}

function clearErrorOverlay() {
  document
    .querySelectorAll(overlayId)
    .forEach((n) => (n as ErrorOverlay).close());
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

async function fetchUpdate({
  path,
  acceptedPath,
  timestamp,
  explicitImportRequired,
}: Update) {
  const mod = hotModulesMap.get(path);
  if (!mod) {
    return;
  }

  let fetchedModule: ModuleNamespace | undefined;
  const isSelfUpdate = path === acceptedPath;

  const qualifiedCallbacks = mod.callbacks.filter(({ deps }) =>
    deps.includes(acceptedPath)
  );

  if (isSelfUpdate || qualifiedCallbacks.length > 0) {
    const disposer = disposeMap.get(acceptedPath);
    if (disposer) await disposer(dataMap.get(acceptedPath));
    const [acceptedPathWithoutQuery, query] = acceptedPath.split(`?`);
    try {
      fetchedModule = await import(
        /* @vite-ignore */
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
    for (const { deps, fn } of qualifiedCallbacks) {
      fn(deps.map((dep) => (dep === acceptedPath ? fetchedModule : undefined)));
    }
    const loggedPath = isSelfUpdate ? path : `${acceptedPath} via ${path}`;
    console.debug(`[vite] hot updated: ${loggedPath}`);
  };
}

function cleanUrl(pathname: string): string {
  const url = new URL(pathname, location.toString());
  url.searchParams.delete("direct");
  return url.pathname + url.search;
}

function createErrorOverlay(err: ErrorPayload["err"]) {
  if (!enableOverlay) return;
  clearErrorOverlay();
  document.body.appendChild(new ErrorOverlay(err));
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

export function createHotContext(ownerPath: string): ViteHotContext {
  if (!dataMap.has(ownerPath)) {
    dataMap.set(ownerPath, {});
  }

  // when a file is hot updated, a new context is created
  // clear its stale callbacks
  const mod = hotModulesMap.get(ownerPath);
  if (mod) {
    mod.callbacks = [];
  }

  // clear stale custom event listeners
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

    // export names (first arg) are irrelevant on the client side, they're
    // extracted in the server for propagation
    acceptExports(_, callback) {
      acceptDeps([ownerPath], ([mod]) => callback?.(mod));
    },

    dispose(cb) {
      disposeMap.set(ownerPath, cb);
    },

    prune(cb) {
      pruneMap.set(ownerPath, cb);
    },

    // Kept for backward compatibility (#11036)
    // @ts-expect-error untyped
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    decline() {},

    // tell the server to re-perform hmr propagation from this module as root
    invalidate(message) {
      notifyListeners("vite:invalidate", { path: ownerPath, message });
      this.send("vite:invalidate", { path: ownerPath, message });
      console.debug(
        `[vite] invalidate ${ownerPath}${message ? `: ${message}` : ""}`
      );
    },

    // custom events
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
let lastInsertedStyle: HTMLStyleElement | undefined
const sheetsMap = new Map<string, HTMLStyleElement>()
// TODO
export function updateStyle(id: string, content: string): void {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-vite-dev-id", id);
    style.textContent = content;

    if (!lastInsertedStyle) {
      document.head.appendChild(style);

      // reset lastInsertedStyle after async
      // because dynamically imported css will be splitted into a different file
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

// TODO
export function removeStyle(id: string): void {
  const style = sheetsMap.get(id)
  if (style) {
    document.head.removeChild(style)
    sheetsMap.delete(id)
  }
}
export { ErrorOverlay };
