import { PackageCache, PackageData } from "../packages";
import { Plugin } from "../plugin";
import {
  bareImportRE,
  cleanUrl,
  createDebugger,
  fsPathFromId,
  isInNodeModules,
  isNonDriveRelativeAbsolutePath,
  isTsRequest,
  normalizePath,
  safeRealpathSync,
  tryStatSync,
} from "../utils";
import path from "path";
import { PartialResolvedId } from "rollup";
import { FS_PREFIX } from "../constants";
import colors from "picocolors";
import fs from "node:fs";
import { resolvePackageData } from "../packages";
import { exports, imports } from "resolve.exports";

export interface ResolveOptions {
  mainFields?: string[];
  conditions?: string[];
  extensions?: string[];
  dedupe?: string[];
  preserveSymlinks?: boolean;
}

export interface InternalResolveOptions extends Required<ResolveOptions> {
  root: string;
  isBuild: boolean;
  packageCache?: PackageCache;
  asSrc?: boolean;
  tryIndex?: boolean;
  preferRelative?: boolean;
  isRequire?: boolean;
  isFromTsImporter?: boolean;
  tryEsmOnly?: boolean;
  scan?: boolean;
  idOnly?: boolean;
}
const startsWithWordCharRE = /^\w/;

const debug = createDebugger("vite:resolve-details", {
  onlyWhenFocused: true,
});
export const browserExternalId = "__vite-browser-external";

export type InternalResolveOptionsWithOverrideConditions =
  InternalResolveOptions & {
    overrideConditions?: string[];
  };

export function resolvePlugin(resolveOptions: InternalResolveOptions): Plugin {
  const { root, asSrc, preferRelative = false } = resolveOptions;
  const rootInRoot = false;
  return {
    name: "vite:resolve",

    async resolveId(id, importer, resolveOpts) {
      if (
        id[0] === "\0" ||
        id.startsWith("virtual:") ||
        id.startsWith("/virtual:")
      ) {
        return;
      }
      const targetWeb = true;

      const isRequire: boolean =
        resolveOpts?.custom?.["node-resolve"]?.isRequire ?? false;

      const options: InternalResolveOptions = {
        isRequire,
        ...resolveOptions,
        scan: resolveOpts?.scan ?? resolveOptions.scan,
      };

      if (importer) {
        if (
          isTsRequest(importer) ||
          resolveOpts.custom?.depScan?.loader?.startsWith("ts")
        ) {
          options.isFromTsImporter = true;
        } else {
          const moduleLang = this.getModuleInfo(importer)?.meta?.vite?.lang;
          options.isFromTsImporter =
            moduleLang && isTsRequest(`.${moduleLang}`);
        }
      }

      let res: string | PartialResolvedId | undefined;

      if (asSrc && id.startsWith(FS_PREFIX)) {
        res = fsPathFromId(id);
        debug?.(`[@fs] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        return res;
      }

      if (asSrc && id[0] === "/" && (rootInRoot || !id.startsWith(root))) {
        const fsPath = path.resolve(root, id.slice(1));
        if ((res = tryFsResolve(fsPath, options))) {
          debug?.(`[url] ${colors.cyan(id)} -> ${colors.dim(res)}`);
          return res;
        }
      }

      if (
        id[0] === "." ||
        ((preferRelative || importer?.endsWith(".html")) &&
          startsWithWordCharRE.test(id))
      ) {
        const basedir = importer ? path.dirname(importer) : process.cwd();
        const fsPath = path.resolve(basedir, id);

        if ((res = tryFsResolve(fsPath, options))) {
          debug?.(`[relative] ${colors.cyan(id)} -> ${colors.dim(res)}`);
          return res;
        }
      }
      if (
        isNonDriveRelativeAbsolutePath(id) &&
        (res = tryFsResolve(id, options))
      ) {
        debug?.(`[fs] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        return res;
      }

      if (bareImportRE.test(id)) {
        if ((res = tryNodeResolve(id, importer, options, targetWeb))) {
          return res;
        }
      }

      debug?.(`[fallthrough] ${colors.dim(id)}`);
    },
  };
}

export function tryNodeResolve(
  id: string,
  importer: string | null | undefined,
  options: InternalResolveOptionsWithOverrideConditions,
  targetWeb: boolean
): PartialResolvedId | undefined {
  const { root, preserveSymlinks, packageCache } = options;

  const pkgId = id;

  let basedir: string;
  if (
    importer &&
    path.isAbsolute(importer) &&
    (importer[importer.length - 1] === "*" || fs.existsSync(cleanUrl(importer)))
  ) {
    basedir = path.dirname(importer);
  } else {
    basedir = root;
  }

  const pkg = resolvePackageData(
    pkgId,
    basedir,
    preserveSymlinks,
    packageCache
  );
  if (!pkg)
    throw new Error(`cannot find package.json for module ${id} in ${basedir}`);
  const resolveId = resolvePackageEntry;
  const unresolvedId = pkgId;

  let resolved: string | undefined;
  try {
    resolved = resolveId(unresolvedId, pkg, targetWeb, options);
  } catch (err) {
    if (!options.tryEsmOnly) {
      throw err;
    }
  }
  if (!resolved) {
    throw new Error(`cannot resolve PackageData`);
  }
  return { id: resolved };
}
function resolveExportsOrImports(
  pkg: PackageData["data"],
  key: string,
  options: InternalResolveOptionsWithOverrideConditions,
  targetWeb: boolean,
  type: "imports" | "exports"
) {
  const additionalConditions = new Set(
    options.overrideConditions || [
      "production",
      "development",
      "module",
      ...options.conditions,
    ]
  );

  const conditions = [...additionalConditions].filter((condition) => {
    switch (condition) {
      case "production":
        return false;
      case "development":
        return true;
      case "module":
        return !options.isRequire;
    }
    return true;
  });

  const fn = type === "imports" ? imports : exports;
  const result = fn(pkg, key, {
    browser: targetWeb && !additionalConditions.has("node"),
    require: options.isRequire && !additionalConditions.has("import"),
    conditions,
  });

  return result ? result[0] : undefined;
}

function splitFileAndPostfix(path: string) {
  const file = cleanUrl(path);
  return { file, postfix: path.slice(file.length) };
}

function tryFsResolve(
  fsPath: string,
  options: InternalResolveOptions
): string | undefined {
  const hashIndex = fsPath.indexOf("#");
  if (hashIndex >= 0 && isInNodeModules(fsPath)) {
    const queryIndex = fsPath.indexOf("?");
    if (queryIndex < 0 || queryIndex > hashIndex) {
      const file =
        queryIndex > hashIndex ? fsPath.slice(0, queryIndex) : fsPath;
      const res = tryCleanFsResolve(file, options);
      if (res) return res + fsPath.slice(file.length);
    }
  }

  const { file, postfix } = splitFileAndPostfix(fsPath);
  const res = tryCleanFsResolve(file, options);
  if (res) return res + postfix;
}
/**解析package.json的入口路径 */
export function resolvePackageEntry(
  id: string,
  { dir, data, setResolvedCache, getResolvedCache }: PackageData,
  targetWeb: boolean,
  options: InternalResolveOptions
): string | undefined {
  const cached = getResolvedCache(".", targetWeb);
  if (cached) {
    return cached;
  }
  try {
    let entryPoint: string | undefined;

    if (data.exports) {
      entryPoint = resolveExportsOrImports(
        data,
        ".",
        options,
        targetWeb,
        "exports"
      );
    }

    const resolvedFromExports = !!entryPoint;

    if (!resolvedFromExports && (!entryPoint || entryPoint.endsWith(".mjs"))) {
      for (const field of options.mainFields) {
        if (field === "browser") continue;
        if (typeof data[field] === "string") {
          entryPoint = data[field];
          break;
        }
      }
    }
    entryPoint ||= data.main;

    const entryPoints = entryPoint
      ? [entryPoint]
      : ["index.js", "index.json", "index.node"];

    for (let entry of entryPoints) {
      const entryPointPath = path.join(dir, entry);
      const resolvedEntryPoint = tryFsResolve(entryPointPath, options);
      if (resolvedEntryPoint) {
        debug?.(
          `[package entry] ${colors.cyan(id)} -> ${colors.dim(
            resolvedEntryPoint
          )}`
        );
        setResolvedCache(".", resolvedEntryPoint, targetWeb);
        return resolvedEntryPoint;
      }
    }
  } catch (e) {
    packageEntryFailure(id, e.message);
  }
  packageEntryFailure(id);
}

function packageEntryFailure(id: string, details?: string) {
  throw new Error(
    `Failed to resolve entry for package "${id}". ` +
      `The package may have incorrect main/module/exports specified in its package.json` +
      (details ? ": " + details : ".")
  );
}

function getRealPath(resolved: string, preserveSymlinks?: boolean): string {
  if (!preserveSymlinks && browserExternalId !== resolved) {
    resolved = safeRealpathSync(resolved);
  }
  return normalizePath(resolved);
}

function tryCleanFsResolve(
  file: string,
  options: InternalResolveOptions
): string | undefined {
  const fileStat = tryStatSync(file);

  if (fileStat?.isFile()) return getRealPath(file, options.preserveSymlinks);
}
