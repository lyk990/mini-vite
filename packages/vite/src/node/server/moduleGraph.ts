import { extname } from "node:path";
import type { ModuleInfo, PartialResolvedId } from "rollup";
import { isDirectCSSRequest } from "../plugins/css";
import { cleanUrl, removeImportQuery, removeTimestampQuery } from "../utils";
import type { TransformResult } from "./transformRequest";

export class ModuleNode {
  url: string;
  id: string | null = null;
  file: string | null = null;
  type: "js" | "css";
  info?: ModuleInfo;
  meta?: Record<string, any>;
  importers = new Set<ModuleNode>();
  importedModules = new Set<ModuleNode>();
  acceptedHmrDeps = new Set<ModuleNode>();
  acceptedHmrExports: Set<string> | null = null;
  importedBindings: Map<string, Set<string>> | null = null;
  isSelfAccepting?: boolean;
  transformResult: TransformResult | null = null;
  ssrTransformResult: TransformResult | null = null;
  ssrModule: Record<string, any> | null = null;
  ssrError: Error | null = null;
  lastHMRTimestamp = 0;
  lastInvalidationTimestamp = 0;

  constructor(url: string, setIsSelfAccepting = true) {
    this.url = url;
    this.type = isDirectCSSRequest(url) ? "css" : "js";
    if (setIsSelfAccepting) {
      this.isSelfAccepting = false;
    }
  }
}

export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined
];

export class ModuleGraph {
  // key: '/src/main.ts'
  // 将原始路径映射到模块对象中
  // 主要用于模块热更新、服务端渲染、将 URL 转换为对应的模块路径，并加载相应的模块资源
  urlToModuleMap = new Map<string, ModuleNode>();
  // key: 'C:/Users/Administrator/Desktop/learn-Code/vite源码/mini-vite/mini-vite-example/src/main.ts'
  // resolveId之后的路径与模块对象的映射，可用来快速查找和访问对应的模块节点。

  // 主要用于查找对应的模块对象，获取模块的代码和其他相关信息
  // 根据模块 ID 查找对应的模块对象，并获取其依赖关系，从而构建整个模块依赖图。
  // 当一个模块发生变化时，可以根据模块 ID 从 idToModuleMap 中查找对应的模块对象，
  // 然后通知客户端更新相应的模块
  // 在开发环境下，存储已解析和加载的模块对象
  idToModuleMap = new Map<string, ModuleNode>();
  // key: 'C:/Users/Administrator/Desktop/learn-Code/vite源码/mini-vite/mini-vite-example/src/main.ts'
  // 文件路径与模块对象的映射，用来跟踪具有相同文件路径的模块节点（文件路径只有一个）
  // 主要用于模块解析、模块依赖管理、模块热更新和模块缓存管理
  fileToModulesMap = new Map<string, Set<ModuleNode>>();
  // 主要包括src/App.vue, node_modules中的第三方依赖等
  // 主要作用是确保指定的模块路径是安全的，vite核心模块不会被修改或覆盖。
  // 可以指定这些第三方模块的路径，确保它们不会被修改。
  // 这有助于保护核心模块和第三方模块的完整性，并避免意外冲突和覆盖。
  safeModulesPath = new Set<string>();

  // key: '/src/main.ts'
  // 将未解析的 URL 与相应的模块进行关联
  // 主要用于模块解析、模块加载、模块热更新和模块缓存管理等功
  _unresolvedUrlToModuleMap = new Map<
    string,
    Promise<ModuleNode> | ModuleNode
  >();

  constructor(
    private resolveId: (url: string) => Promise<PartialResolvedId | null>
  ) {}

  async getModuleByUrl(rawUrl: string): Promise<ModuleNode | undefined> {
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl));
    const mod = this._getUnresolvedUrlToModule(rawUrl);
    if (mod) {
      return mod;
    }

    const [url] = await this._resolveUrl(rawUrl);
    return this.urlToModuleMap.get(url);
  }

  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id));
  }

  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file);
  }

  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file);
    if (mods) {
      const seen = new Set<ModuleNode>();
      mods.forEach((mod) => {
        // 对受到文件变化影响的模块的标记成失效状态
        // 为了确保模块系统能够及时更新和重新加载这些模块
        // 文件发生变化,或文件删除时,将其标记为失效状态
        // 然后,模块系统在下一次需要使用到这些模块时，
        // 会重新加载、解析和执行这些模块，从而使模块的最新状态得以反映出来
        this.invalidateModule(mod, seen);
      });
    }
  }

  invalidateModule(
    mod: ModuleNode,
    seen: Set<ModuleNode> = new Set(),
    timestamp: number = Date.now(),
    isHmr: boolean = false
  ): void {
    if (seen.has(mod)) {
      return;
    }
    seen.add(mod);
    if (isHmr) {
      mod.lastHMRTimestamp = timestamp;
    } else {
      mod.lastInvalidationTimestamp = timestamp;
    }

    mod.transformResult = null;
    mod.ssrTransformResult = null;
    mod.ssrModule = null;
    mod.ssrError = null;
    mod.importers.forEach((importer) => {
      if (!importer.acceptedHmrDeps.has(mod)) {
        this.invalidateModule(importer, seen, timestamp, isHmr);
      }
    });
  }

  async updateModuleInfo(
    mod: ModuleNode,
    importedModules: Set<string | ModuleNode>,
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | ModuleNode>,
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean
  ): Promise<Set<ModuleNode> | undefined> {
    // 是否接收自身模块的热更新
    mod.isSelfAccepting = isSelfAccepting;
    // 将所有的imports模块存储到prevImports中
    const prevImports = mod.importedModules;
    // 不会再被import
    let noLongerImported: Set<ModuleNode> | undefined;
    // 存储异步解析的promise对象
    let resolvePromises = [];
    // 存储每个异步解析的结果
    let resolveResults = new Array(importedModules.size);
    let index = 0;
    // 绑定节点依赖关系
    for (const imported of importedModules) {
      const nextIndex = index++;
      if (typeof imported === "string") {
        resolvePromises.push(
          this.ensureEntryFromUrl(imported).then((dep) => {
            dep.importers.add(mod);
            resolveResults[nextIndex] = dep;
          })
        );
      } else {
        imported.importers.add(mod);
        resolveResults[nextIndex] = imported;
      }
    }

    if (resolvePromises.length) {
      // 等待所有的异步解析操作完成
      await Promise.all(resolvePromises);
    }
    // nextImports保存着所有解析出来的import模块的
    const nextImports = (mod.importedModules = new Set(resolveResults));
    // prevImports存储着所有的imports模块
    // 与nextImports做对比,判断模块是否已经被解析了
    // 主要是为了更新模块的导入管理,移除不需要被导入的模块
    prevImports.forEach((dep) => {
      if (!nextImports.has(dep)) {
        dep.importers.delete(mod);
        if (!dep.importers.size) {
          (noLongerImported || (noLongerImported = new Set())).add(dep);
        }
      }
    });

    resolvePromises = [];
    resolveResults = new Array(acceptedModules.size);
    index = 0;
    // 更新最新的热更新模块的信息
    for (const accepted of acceptedModules) {
      const nextIndex = index++;
      if (typeof accepted === "string") {
        resolvePromises.push(
          this.ensureEntryFromUrl(accepted).then((dep) => {
            resolveResults[nextIndex] = dep;
          })
        );
      } else {
        resolveResults[nextIndex] = accepted;
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises);
    }

    mod.acceptedHmrDeps = new Set(resolveResults);

    mod.acceptedHmrExports = acceptedExports;
    // 当前模块导入的绑定关系的映射
    mod.importedBindings = importedBindings;
    return noLongerImported;
  }

  async ensureEntryFromUrl(
    rawUrl: string,
    setIsSelfAccepting = true
  ): Promise<ModuleNode> {
    return this._ensureEntryFromUrl(rawUrl, setIsSelfAccepting);
  }

  async _ensureEntryFromUrl(
    rawUrl: string,
    setIsSelfAccepting = true,
    resolved?: PartialResolvedId
  ): Promise<ModuleNode> {
    // 移除url上的时间戳查询参数,得到一个经过处理后的url
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl));
    // 通过url判断_unresolvedUrlToModuleMap是否存在未解析的模块
    // 有就直接返回，没有就接着往下处理
    let mod = this._getUnresolvedUrlToModule(rawUrl);
    if (mod) {
      return mod;
    }
    // 异步地解析 URL 并创建相应的模块节点 (mod)
    const modPromise = (async () => {
      // 获取解析后的 URL、解析后的标识符 resolvedId 和元数据 meta
      const [url, resolvedId, meta] = await this._resolveUrl(rawUrl, resolved);
      // 通过 resolvedId从idToModuleMap 中找到对应的模块（mod）
      mod = this.idToModuleMap.get(resolvedId);
      // 如果没有的话就创建一个新的mod
      if (!mod) {
        mod = new ModuleNode(url, setIsSelfAccepting);

        if (meta) mod.meta = meta;
        // 将url与模块（mod）关联起来并存储到urlToModuleMap中
        this.urlToModuleMap.set(url, mod);
        mod.id = resolvedId;
        // 模块id存到idToModuleMap中
        this.idToModuleMap.set(resolvedId, mod);
        // 解析出file（文件绝对路径）
        const file = (mod.file = cleanUrl(resolvedId));
        // 判断file是否已经存储到fileToModulesMap中
        let fileMappedModules = this.fileToModulesMap.get(file);
        // 没有的话，file存到fileToModulesMap中
        if (!fileMappedModules) {
          fileMappedModules = new Set();
          this.fileToModulesMap.set(file, fileMappedModules);
        }
        // fileToModulesMap是一个一对多的数据结构
        // 它的key为文件路径，value为模块（mode）
        // 有可能多个模块引用了同一个文件作为它们的依赖项
        // 或者模块被多个入口文件引用，或者在多个地方被动态引入。
        // 所以此处是将模块节点添加到与文件路径相关联的模块集合中，
        // 以便在文件更新时进行批量处理和更新
        fileMappedModules.add(mod);
      } else if (!this.urlToModuleMap.has(url)) {
        this.urlToModuleMap.set(url, mod);
      }

      this._setUnresolvedUrlToModule(rawUrl, mod);
      return mod;
    })();
    // 调用 _setUnresolvedUrlToModule 两次的目的是
    // 为了确保未解析的 URL 在解析过程中能够正确关联到对应的模块节点，
    // 并且在需要获取模块的地方能够等待解析的 Promise 完成。
    this._setUnresolvedUrlToModule(rawUrl, modPromise);
    return modPromise;
  }

  async resolveUrl(url: string): Promise<ResolvedUrl> {
    url = removeImportQuery(removeTimestampQuery(url));
    const mod = await this._getUnresolvedUrlToModule(url);
    if (mod?.id) {
      return [mod.url, mod.id, mod.meta];
    }
    return this._resolveUrl(url);
  }

  _getUnresolvedUrlToModule(
    url: string
  ): Promise<ModuleNode> | ModuleNode | undefined {
    return this._unresolvedUrlToModuleMap.get(url);
  }

  _setUnresolvedUrlToModule(
    url: string,
    mod: Promise<ModuleNode> | ModuleNode
  ): void {
    this._unresolvedUrlToModuleMap.set(url, mod);
  }

  async _resolveUrl(
    url: string,
    alreadyResolved?: PartialResolvedId
  ): Promise<ResolvedUrl> {
    const resolved = alreadyResolved ?? (await this.resolveId(url));
    const resolvedId = resolved?.id || url;
    if (
      url !== resolvedId &&
      !url.includes("\0") &&
      !url.startsWith(`virtual:`)
    ) {
      const ext = extname(cleanUrl(resolvedId));
      if (ext) {
        const pathname = cleanUrl(url);
        if (!pathname.endsWith(ext)) {
          url = pathname + ext + url.slice(pathname.length);
        }
      }
    }
    return [url, resolvedId, resolved?.meta];
  }
}
