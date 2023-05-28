import { extname } from "node:path";
import type { ModuleInfo, PartialResolvedId } from "rollup";
import { isDirectCSSRequest } from "../plugins/css";
import {
  cleanUrl,
  normalizePath,
  removeImportQuery,
  removeTimestampQuery,
} from "../utils";
import { FS_PREFIX } from "../constants";
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
  urlToModuleMap = new Map<string, ModuleNode>();
  idToModuleMap = new Map<string, ModuleNode>();
  fileToModulesMap = new Map<string, Set<ModuleNode>>();
  safeModulesPath = new Set<string>();

  _unresolvedUrlToModuleMap = new Map<
    string,
    Promise<ModuleNode> | ModuleNode
  >();

  constructor(
    private resolveId: (
      url: string
      // ssr: boolean
    ) => Promise<PartialResolvedId | null>
  ) {}

  async getModuleByUrl(
    rawUrl: string
    // ssr?: boolean
  ): Promise<ModuleNode | undefined> {
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

  invalidateAll(): void {
    const timestamp = Date.now();
    const seen = new Set<ModuleNode>();
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen, timestamp);
    });
  }

  async updateModuleInfo(
    mod: ModuleNode,
    importedModules: Set<string | ModuleNode>,
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | ModuleNode>,
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean
    // ssr?: boolean
  ): Promise<Set<ModuleNode> | undefined> {
    mod.isSelfAccepting = isSelfAccepting;
    const prevImports = mod.importedModules;
    let noLongerImported: Set<ModuleNode> | undefined;

    let resolvePromises = [];
    let resolveResults = new Array(importedModules.size);
    let index = 0;
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
      await Promise.all(resolvePromises);
    }

    const nextImports = (mod.importedModules = new Set(resolveResults));

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
    mod.importedBindings = importedBindings;
    return noLongerImported;
  }

  async ensureEntryFromUrl(
    rawUrl: string,
    // ssr?: boolean,
    setIsSelfAccepting = true
  ): Promise<ModuleNode> {
    return this._ensureEntryFromUrl(rawUrl, setIsSelfAccepting);
  }

  async _ensureEntryFromUrl(
    rawUrl: string,
    // ssr?: boolean,
    setIsSelfAccepting = true,
    resolved?: PartialResolvedId
  ): Promise<ModuleNode> {
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl));
    let mod = this._getUnresolvedUrlToModule(rawUrl);
    if (mod) {
      return mod;
    }
    const modPromise = (async () => {
      const [url, resolvedId, meta] = await this._resolveUrl(
        rawUrl,
        // ssr,
        resolved
      );
      mod = this.idToModuleMap.get(resolvedId);
      if (!mod) {
        mod = new ModuleNode(url, setIsSelfAccepting);
        if (meta) mod.meta = meta;
        this.urlToModuleMap.set(url, mod);
        mod.id = resolvedId;
        this.idToModuleMap.set(resolvedId, mod);
        const file = (mod.file = cleanUrl(resolvedId));
        let fileMappedModules = this.fileToModulesMap.get(file);
        if (!fileMappedModules) {
          fileMappedModules = new Set();
          this.fileToModulesMap.set(file, fileMappedModules);
        }
        fileMappedModules.add(mod);
      } else if (!this.urlToModuleMap.has(url)) {
        this.urlToModuleMap.set(url, mod);
      }
      this._setUnresolvedUrlToModule(rawUrl, mod);
      return mod;
    })();

    this._setUnresolvedUrlToModule(rawUrl, modPromise);
    return modPromise;
  }

  createFileOnlyEntry(file: string): ModuleNode {
    file = normalizePath(file);
    let fileMappedModules = this.fileToModulesMap.get(file);
    if (!fileMappedModules) {
      fileMappedModules = new Set();
      this.fileToModulesMap.set(file, fileMappedModules);
    }

    const url = `${FS_PREFIX}${file}`;
    for (const m of fileMappedModules) {
      if (m.url === url || m.id === file) {
        return m;
      }
    }

    const mod = new ModuleNode(url);
    mod.file = file;
    fileMappedModules.add(mod);
    return mod;
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
    // ssr?: boolean,
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
