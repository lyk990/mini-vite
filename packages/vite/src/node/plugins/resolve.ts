import { SSROptions } from "vite";
import {
  findNearestPackageData,
  loadPackageData,
  PackageCache,
  PackageData,
} from "../packages";
import { Plugin } from "../plugin";
import {
  bareImportRE,
  cleanUrl,
  createDebugger,
  deepImportRE,
  fsPathFromId,
  injectQuery,
  isBuiltin,
  isDataUrl,
  isExternalUrl,
  isInNodeModules,
  isNonDriveRelativeAbsolutePath,
  isObject,
  isOptimizable,
  isTsRequest,
  isWindows,
  normalizePath,
  safeRealpathSync,
  slash,
  tryStatSync,
} from "../utils";
import path from "path";
import { PartialResolvedId } from "rollup";
import {
  CLIENT_ENTRY,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAIN_FIELDS,
  DEP_VERSION_RE,
  ENV_ENTRY,
  FS_PREFIX,
  OPTIMIZABLE_ENTRY_RE,
  SPECIAL_QUERY_RE,
} from "../constants";
import colors from "picocolors";
import { optimizedDepInfoFromFile, optimizedDepInfoFromId } from "../optimizer";
import fs from "node:fs";
import { findNearestMainPackageData, resolvePackageData } from "../package";
import { exports, imports } from "resolve.exports";
import { hasESMSyntax } from "mlly";
import type { DepsOptimizer } from "../optimizer";

export interface ResolveOptions {
  mainFields?: string[];
  browserField?: boolean;
  conditions?: string[];
  extensions?: string[];
  dedupe?: string[];
  preserveSymlinks?: boolean;
}

export interface InternalResolveOptions extends Required<ResolveOptions> {
  root: string;
  isBuild: boolean;
  isProduction: boolean;
  ssrConfig?: SSROptions;
  packageCache?: PackageCache;
  asSrc?: boolean;
  tryIndex?: boolean;
  tryPrefix?: string;
  preferRelative?: boolean;
  isRequire?: boolean;
  isFromTsImporter?: boolean;
  tryEsmOnly?: boolean;
  scan?: boolean;
  ssrOptimizeCheck?: boolean;
  getDepsOptimizer?: (ssr: boolean) => DepsOptimizer | undefined;
  shouldExternalize?: (id: string) => boolean | undefined;
  idOnly?: boolean;
}
const startsWithWordCharRE = /^\w/;

const debug = createDebugger("vite:resolve-details", {
  onlyWhenFocused: true,
});
export const browserExternalId = "__vite-browser-external";
export const optionalPeerDepId = "__vite-optional-peer-dep";

export type InternalResolveOptionsWithOverrideConditions =
  InternalResolveOptions & {
    overrideConditions?: string[];
  };

export function resolvePlugin(resolveOptions: InternalResolveOptions): Plugin {
  const {
    root,
    isProduction,
    asSrc,
    ssrConfig,
    preferRelative = false,
  } = resolveOptions;

  const { target: ssrTarget, noExternal: ssrNoExternal } = ssrConfig ?? {};

  const rootInRoot = tryStatSync(path.join(root, root))?.isDirectory() ?? false;

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

      const ssr = resolveOpts?.ssr === true;

      const depsOptimizer = resolveOptions.getDepsOptimizer?.(ssr);

      if (id.startsWith(browserExternalId)) {
        return id;
      }

      const targetWeb = !ssr || ssrTarget === "webworker";

      const isRequire: boolean =
        resolveOpts?.custom?.["node-resolve"]?.isRequire ?? false;

      const options: InternalResolveOptions = {
        isRequire,
        ...resolveOptions,
        scan: resolveOpts?.scan ?? resolveOptions.scan,
      };

      const resolvedImports = resolveSubpathImports(
        id,
        importer,
        options,
        targetWeb
      );
      if (resolvedImports) {
        id = resolvedImports;
      }

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

      if (asSrc && depsOptimizer?.isOptimizedDepUrl(id)) {
        const optimizedPath = id.startsWith(FS_PREFIX)
          ? fsPathFromId(id)
          : normalizePath(path.resolve(root, id.slice(1)));
        return optimizedPath;
      }

      if (asSrc && id.startsWith(FS_PREFIX)) {
        res = fsPathFromId(id);
        debug?.(`[@fs] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        return ensureVersionQuery(res, id, options, depsOptimizer);
      }

      if (asSrc && id[0] === "/" && (rootInRoot || !id.startsWith(root))) {
        const fsPath = path.resolve(root, id.slice(1));
        if ((res = tryFsResolve(fsPath, options))) {
          debug?.(`[url] ${colors.cyan(id)} -> ${colors.dim(res)}`);
          return ensureVersionQuery(res, id, options, depsOptimizer);
        }
      }

      if (
        id[0] === "." ||
        ((preferRelative || importer?.endsWith(".html")) &&
          startsWithWordCharRE.test(id))
      ) {
        const basedir = importer ? path.dirname(importer) : process.cwd();
        const fsPath = path.resolve(basedir, id);

        const normalizedFsPath = normalizePath(fsPath);

        if (depsOptimizer?.isOptimizedDepFile(normalizedFsPath)) {
          if (!normalizedFsPath.match(DEP_VERSION_RE)) {
            const browserHash = optimizedDepInfoFromFile(
              depsOptimizer.metadata,
              normalizedFsPath
            )?.browserHash;
            if (browserHash) {
              return injectQuery(normalizedFsPath, `v=${browserHash}`);
            }
          }
          return normalizedFsPath;
        }

        if (
          targetWeb &&
          options.browserField &&
          (res = tryResolveBrowserMapping(fsPath, importer, options, true))
        ) {
          return res;
        }

        if ((res = tryFsResolve(fsPath, options))) {
          res = ensureVersionQuery(res, id, options, depsOptimizer);
          debug?.(`[relative] ${colors.cyan(id)} -> ${colors.dim(res)}`);

          if (
            !options.idOnly &&
            !options.scan &&
            options.isBuild &&
            !importer?.endsWith(".html")
          ) {
            const resPkg = findNearestPackageData(
              path.dirname(res),
              options.packageCache
            );
            if (resPkg) {
              return {
                id: res,
                moduleSideEffects: resPkg.hasSideEffects(res),
              };
            }
          }
          return res;
        }
      }

      if (isWindows && id[0] === "/") {
        const basedir = importer ? path.dirname(importer) : process.cwd();
        const fsPath = path.resolve(basedir, id);
        if ((res = tryFsResolve(fsPath, options))) {
          debug?.(`[drive-relative] ${colors.cyan(id)} -> ${colors.dim(res)}`);
          return ensureVersionQuery(res, id, options, depsOptimizer);
        }
      }

      if (
        isNonDriveRelativeAbsolutePath(id) &&
        (res = tryFsResolve(id, options))
      ) {
        debug?.(`[fs] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        return ensureVersionQuery(res, id, options, depsOptimizer);
      }

      if (isExternalUrl(id)) {
        return options.idOnly ? id : { id, external: true };
      }

      if (isDataUrl(id)) {
        return null;
      }

      if (bareImportRE.test(id)) {
        const external = options.shouldExternalize?.(id);
        if (
          !external &&
          asSrc &&
          depsOptimizer &&
          !options.scan &&
          (res = await tryOptimizedResolve(
            depsOptimizer,
            id,
            importer,
            options.preserveSymlinks,
            options.packageCache
          ))
        ) {
          return res;
        }

        if (
          targetWeb &&
          options.browserField &&
          (res = tryResolveBrowserMapping(
            id,
            importer,
            options,
            false,
            external
          ))
        ) {
          return res;
        }

        if (
          (res = tryNodeResolve(
            id,
            importer,
            options,
            targetWeb,
            depsOptimizer,
            ssr,
            external
          ))
        ) {
          return res;
        }

        if (isBuiltin(id)) {
          if (ssr) {
            if (ssrNoExternal === true) {
              let message = `Cannot bundle Node.js built-in "${id}"`;
              if (importer) {
                message += ` imported from "${path.relative(
                  process.cwd(),
                  importer
                )}"`;
              }
              message += `. Consider disabling ssr.noExternal or remove the built-in dependency.`;
              this.error(message);
            }

            return options.idOnly ? id : { id, external: true };
          } else {
            if (!asSrc) {
              debug?.(
                `externalized node built-in "${id}" to empty module. ` +
                  `(imported by: ${colors.white(colors.dim(importer))})`
              );
            } else if (isProduction) {
              this.warn(
                `Module "${id}" has been externalized for browser compatibility, imported by "${importer}". ` +
                  `See http://vitejs.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.`
              );
            }
            return isProduction
              ? browserExternalId
              : `${browserExternalId}:${id}`;
          }
        }
      }

      debug?.(`[fallthrough] ${colors.dim(id)}`);
    },

    load(id) {
      if (id.startsWith(browserExternalId)) {
        if (isProduction) {
          return `export default {}`;
        } else {
          id = id.slice(browserExternalId.length + 1);
          return `\
  export default new Proxy({}, {
    get(_, key) {
      throw new Error(\`Module "${id}" has been externalized for browser compatibility. Cannot access "${id}.\${key}" in client code.  See http://vitejs.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.\`)
    }
  })`;
        }
      }
      if (id.startsWith(optionalPeerDepId)) {
        if (isProduction) {
          return `export default {}`;
        } else {
          const [, peerDep, parentDep] = id.split(":");
          return `throw new Error(\`Could not resolve "${peerDep}" imported by "${parentDep}". Is it installed?\`)`;
        }
      }
    },
  };
}

export function tryNodeResolve(
  id: string,
  importer: string | null | undefined,
  options: InternalResolveOptionsWithOverrideConditions,
  targetWeb: boolean,
  depsOptimizer?: DepsOptimizer,
  ssr: boolean = false,
  externalize?: boolean,
  allowLinkedExternal: boolean = true
): PartialResolvedId | undefined {
  const { root, dedupe, isBuild, preserveSymlinks, packageCache } = options;

  const deepMatch = id.match(deepImportRE);
  const pkgId = deepMatch ? deepMatch[1] || deepMatch[2] : id;

  let basedir: string;
  if (dedupe?.includes(pkgId)) {
    basedir = root;
  } else if (
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
  if (!pkg) {
    if (
      basedir !== root && // root has no peer dep
      !isBuiltin(id) &&
      !id.includes("\0") &&
      bareImportRE.test(id)
    ) {
      const mainPkg = findNearestMainPackageData(basedir, packageCache)?.data;
      if (mainPkg) {
        if (
          mainPkg.peerDependencies?.[id] &&
          mainPkg.peerDependenciesMeta?.[id]?.optional
        ) {
          return {
            id: `${optionalPeerDepId}:${id}:${mainPkg.name}`,
          };
        }
      }
    }
    return;
  }

  const resolveId = deepMatch ? resolveDeepImport : resolvePackageEntry;
  const unresolvedId = deepMatch ? "." + id.slice(pkgId.length) : pkgId;

  let resolved: string | undefined;
  try {
    resolved = resolveId(unresolvedId, pkg, targetWeb, options);
  } catch (err) {
    if (!options.tryEsmOnly) {
      throw err;
    }
  }
  if (!resolved && options.tryEsmOnly) {
    resolved = resolveId(unresolvedId, pkg, targetWeb, {
      ...options,
      isRequire: false,
      mainFields: DEFAULT_MAIN_FIELDS,
      extensions: DEFAULT_EXTENSIONS,
    });
  }
  if (!resolved) {
    return;
  }

  const processResult = (resolved: PartialResolvedId) => {
    if (!externalize) {
      return resolved;
    }
    if (!allowLinkedExternal && !isInNodeModules(resolved.id)) {
      return resolved;
    }
    const resolvedExt = path.extname(resolved.id);
    if (
      resolvedExt &&
      resolvedExt !== ".js" &&
      resolvedExt !== ".mjs" &&
      resolvedExt !== ".cjs"
    ) {
      return resolved;
    }
    let resolvedId = id;
    if (deepMatch && !pkg?.data.exports && path.extname(id) !== resolvedExt) {
      const index = resolved.id.indexOf(id);
      if (index > -1) {
        resolvedId = resolved.id.slice(index);
        debug?.(
          `[processResult] ${colors.cyan(id)} -> ${colors.dim(resolvedId)}`
        );
      }
    }
    return { ...resolved, id: resolvedId, external: true };
  };

  if (
    !options.idOnly &&
    ((!options.scan && isBuild && !depsOptimizer) || externalize)
  ) {
    return processResult({
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved),
    });
  }

  const ext = path.extname(resolved);

  if (
    !options.ssrOptimizeCheck &&
    (!isInNodeModules(resolved) || !depsOptimizer || options.scan)
  ) {
    return { id: resolved };
  }

  const isJsType = depsOptimizer
    ? isOptimizable(resolved, depsOptimizer.options)
    : OPTIMIZABLE_ENTRY_RE.test(resolved);

  let exclude = depsOptimizer?.options.exclude;
  let include = depsOptimizer?.options.include;
  if (options.ssrOptimizeCheck) {
    exclude = options.ssrConfig?.optimizeDeps?.exclude;
    include = options.ssrConfig?.optimizeDeps?.include;
  }
  //  REMOVE 有没有可能将这一段逻辑移除
  const skipOptimization =
    // @ts-ignore
    depsOptimizer?.options.noDiscovery ||
    !isJsType ||
    (importer && isInNodeModules(importer)) ||
    exclude?.includes(pkgId) ||
    exclude?.includes(id) ||
    SPECIAL_QUERY_RE.test(resolved) ||
    (!options.ssrOptimizeCheck && !isBuild && ssr) ||
    (ssr &&
      !(
        ext === ".cjs" ||
        (ext === ".js" &&
          findNearestPackageData(path.dirname(resolved), options.packageCache)
            ?.data.type !== "module")
      ) &&
      !(include?.includes(pkgId) || include?.includes(id)));

  if (options.ssrOptimizeCheck) {
    return {
      id: skipOptimization
        ? injectQuery(resolved, `__vite_skip_optimization`)
        : resolved,
    };
  }

  if (skipOptimization) {
    if (!isBuild) {
      const versionHash = depsOptimizer!.metadata.browserHash;
      if (versionHash && isJsType) {
        resolved = injectQuery(resolved, `v=${versionHash}`);
      }
    }
  } else {
    const optimizedInfo = depsOptimizer!.registerMissingImport(id, resolved);
    resolved = depsOptimizer!.getOptimizedDepId(optimizedInfo);
  }

  if (!options.idOnly && !options.scan && isBuild) {
    return {
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved),
    };
  } else {
    return { id: resolved! };
  }
}
const subpathImportsPrefix = "#";
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
        return options.isProduction;
      case "development":
        return !options.isProduction;
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
function resolveSubpathImports(
  id: string,
  importer: string | undefined,
  options: InternalResolveOptions,
  targetWeb: boolean
) {
  if (!importer || !id.startsWith(subpathImportsPrefix)) return;
  const basedir = path.dirname(importer);
  const pkgData = findNearestPackageData(basedir, options.packageCache);
  if (!pkgData) return;

  let importsPath = resolveExportsOrImports(
    pkgData.data,
    id,
    options,
    targetWeb,
    "imports"
  );

  if (importsPath?.[0] === ".") {
    importsPath = path.relative(basedir, path.join(pkgData.dir, importsPath));

    if (importsPath[0] !== ".") {
      importsPath = `./${importsPath}`;
    }
  }

  return importsPath;
}
const normalizedClientEntry = normalizePath(CLIENT_ENTRY);
const normalizedEnvEntry = normalizePath(ENV_ENTRY);
function ensureVersionQuery(
  resolved: string,
  id: string,
  options: InternalResolveOptions,
  depsOptimizer?: DepsOptimizer
): string {
  if (
    !options.isBuild &&
    !options.scan &&
    depsOptimizer &&
    !(resolved === normalizedClientEntry || resolved === normalizedEnvEntry)
  ) {
    const isNodeModule = isInNodeModules(id) || isInNodeModules(resolved);

    if (isNodeModule && !resolved.match(DEP_VERSION_RE)) {
      const versionHash = depsOptimizer.metadata.browserHash;
      if (versionHash && isOptimizable(resolved, depsOptimizer.options)) {
        resolved = injectQuery(resolved, `v=${versionHash}`);
      }
    }
  }
  return resolved;
}

function splitFileAndPostfix(path: string) {
  const file = cleanUrl(path);
  return { file, postfix: path.slice(file.length) };
}

function tryFsResolve(
  fsPath: string,
  options: InternalResolveOptions,
  tryIndex = true,
  targetWeb = true,
  skipPackageJson = false
): string | undefined {
  const hashIndex = fsPath.indexOf("#");
  if (hashIndex >= 0 && isInNodeModules(fsPath)) {
    const queryIndex = fsPath.indexOf("?");
    if (queryIndex < 0 || queryIndex > hashIndex) {
      const file =
        queryIndex > hashIndex ? fsPath.slice(0, queryIndex) : fsPath;
      const res = tryCleanFsResolve(
        file,
        options,
        tryIndex,
        targetWeb,
        skipPackageJson
      );
      if (res) return res + fsPath.slice(file.length);
    }
  }

  const { file, postfix } = splitFileAndPostfix(fsPath);
  const res = tryCleanFsResolve(
    file,
    options,
    tryIndex,
    targetWeb,
    skipPackageJson
  );
  if (res) return res + postfix;
}

function equalWithoutSuffix(path: string, key: string, suffix: string) {
  return key.endsWith(suffix) && key.slice(0, -suffix.length) === path;
}

function mapWithBrowserField(
  relativePathInPkgDir: string,
  map: Record<string, string | false>
): string | false | undefined {
  const normalizedPath = path.posix.normalize(relativePathInPkgDir);

  for (const key in map) {
    const normalizedKey = path.posix.normalize(key);
    if (
      normalizedPath === normalizedKey ||
      equalWithoutSuffix(normalizedPath, normalizedKey, ".js") ||
      equalWithoutSuffix(normalizedPath, normalizedKey, "/index.js")
    ) {
      return map[key];
    }
  }
}

function tryResolveBrowserMapping(
  id: string,
  importer: string | undefined,
  options: InternalResolveOptions,
  isFilePath: boolean,
  externalize?: boolean
) {
  let res: string | undefined;
  const pkg =
    importer &&
    findNearestPackageData(path.dirname(importer), options.packageCache);
  if (pkg && isObject(pkg.data.browser)) {
    const mapId = isFilePath ? "./" + slash(path.relative(pkg.dir, id)) : id;
    const browserMappedPath = mapWithBrowserField(mapId, pkg.data.browser);
    if (browserMappedPath) {
      if (
        (res = bareImportRE.test(browserMappedPath)
          ? tryNodeResolve(browserMappedPath, importer, options, true)?.id
          : tryFsResolve(path.join(pkg.dir, browserMappedPath), options))
      ) {
        debug?.(`[browser mapped] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        let result: PartialResolvedId = { id: res };
        if (options.idOnly) {
          return result;
        }
        if (!options.scan && options.isBuild) {
          const resPkg = findNearestPackageData(
            path.dirname(res),
            options.packageCache
          );
          if (resPkg) {
            result = {
              id: res,
              moduleSideEffects: resPkg.hasSideEffects(res),
            };
          }
        }
        return externalize ? { ...result, external: true } : result;
      }
    } else if (browserMappedPath === false) {
      return browserExternalId;
    }
  }
}

export async function tryOptimizedResolve(
  depsOptimizer: DepsOptimizer,
  id: string,
  importer?: string,
  preserveSymlinks?: boolean,
  packageCache?: PackageCache
): Promise<string | undefined> {
  await depsOptimizer.scanProcessing;

  const metadata = depsOptimizer.metadata;

  const depInfo = optimizedDepInfoFromId(metadata, id);
  if (depInfo) {
    return depsOptimizer.getOptimizedDepId(depInfo);
  }

  if (!importer) return;

  let idPkgDir: string | undefined;
  const nestedIdMatch = `> ${id}`;

  for (const optimizedData of metadata.depInfoList) {
    if (!optimizedData.src) continue; // Ignore chunks

    if (!optimizedData.id.endsWith(nestedIdMatch)) continue;

    if (idPkgDir == null) {
      idPkgDir = resolvePackageData(
        id,
        importer,
        preserveSymlinks,
        packageCache
      )?.dir;
      if (idPkgDir == null) break;
      idPkgDir = normalizePath(idPkgDir);
    }

    if (optimizedData.src.startsWith(idPkgDir)) {
      return depsOptimizer.getOptimizedDepId(optimizedData);
    }
  }
}

function resolveDeepImport(
  id: string,
  {
    webResolvedImports,
    setResolvedCache,
    getResolvedCache,
    dir,
    data,
  }: PackageData,
  targetWeb: boolean,
  options: InternalResolveOptions
): string | undefined {
  const cache = getResolvedCache(id, targetWeb);
  if (cache) {
    return cache;
  }

  let relativeId: string | undefined | void = id;
  const { exports: exportsField, browser: browserField } = data;

  // map relative based on exports data
  if (exportsField) {
    if (isObject(exportsField) && !Array.isArray(exportsField)) {
      // resolve without postfix (see #7098)
      const { file, postfix } = splitFileAndPostfix(relativeId);
      const exportsId = resolveExportsOrImports(
        data,
        file,
        options,
        targetWeb,
        "exports"
      );
      if (exportsId !== undefined) {
        relativeId = exportsId + postfix;
      } else {
        relativeId = undefined;
      }
    } else {
      // not exposed
      relativeId = undefined;
    }
    if (!relativeId) {
      throw new Error(
        `Package subpath '${relativeId}' is not defined by "exports" in ` +
          `${path.join(dir, "package.json")}.`
      );
    }
  } else if (targetWeb && options.browserField && isObject(browserField)) {
    // resolve without postfix (see #7098)
    const { file, postfix } = splitFileAndPostfix(relativeId);
    const mapped = mapWithBrowserField(file, browserField);
    if (mapped) {
      relativeId = mapped + postfix;
    } else if (mapped === false) {
      return (webResolvedImports[id] = browserExternalId);
    }
  }

  if (relativeId) {
    const resolved = tryFsResolve(
      path.join(dir, relativeId),
      options,
      !exportsField, // try index only if no exports field
      targetWeb
    );
    if (resolved) {
      debug?.(
        `[node/deep-import] ${colors.cyan(id)} -> ${colors.dim(resolved)}`
      );
      setResolvedCache(id, resolved, targetWeb);
      return resolved;
    }
  }
}

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

    if (
      targetWeb &&
      options.browserField &&
      (!entryPoint || entryPoint.endsWith(".mjs"))
    ) {
      const browserEntry =
        typeof data.browser === "string"
          ? data.browser
          : isObject(data.browser) && data.browser["."];
      if (browserEntry) {
        if (
          !options.isRequire &&
          options.mainFields.includes("module") &&
          typeof data.module === "string" &&
          data.module !== browserEntry
        ) {
          const resolvedBrowserEntry = tryFsResolve(
            path.join(dir, browserEntry),
            options
          );
          if (resolvedBrowserEntry) {
            const content = fs.readFileSync(resolvedBrowserEntry, "utf-8");
            if (hasESMSyntax(content)) {
              entryPoint = browserEntry;
            } else {
              entryPoint = data.module;
            }
          }
        } else {
          entryPoint = browserEntry;
        }
      }
    }

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
      let skipPackageJson = false;
      if (
        options.mainFields[0] === "sass" &&
        !options.extensions.includes(path.extname(entry))
      ) {
        entry = "";
        skipPackageJson = true;
      } else {
        const { browser: browserField } = data;
        if (targetWeb && options.browserField && isObject(browserField)) {
          entry = mapWithBrowserField(entry, browserField) || entry;
        }
      }

      const entryPointPath = path.join(dir, entry);
      const resolvedEntryPoint = tryFsResolve(
        entryPointPath,
        options,
        true,
        true,
        skipPackageJson
      );
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

function tryResolveRealFileWithExtensions(
  filePath: string,
  extensions: string[],
  preserveSymlinks: boolean
): string | undefined {
  for (const ext of extensions) {
    const res = tryResolveRealFile(filePath + ext, preserveSymlinks);
    if (res) return res;
  }
}

const knownTsOutputRE = /\.(?:js|mjs|cjs|jsx)$/;
const isPossibleTsOutput = (url: string): boolean => knownTsOutputRE.test(url);
function tryCleanFsResolve(
  file: string,
  options: InternalResolveOptions,
  tryIndex = true,
  targetWeb = true,
  skipPackageJson = false
): string | undefined {
  const { tryPrefix, extensions, preserveSymlinks } = options;

  const fileStat = tryStatSync(file);

  if (fileStat?.isFile()) return getRealPath(file, options.preserveSymlinks);

  let res: string | undefined;

  const possibleJsToTs = options.isFromTsImporter && isPossibleTsOutput(file);
  if (possibleJsToTs || extensions.length || tryPrefix) {
    const dirPath = path.dirname(file);
    const dirStat = tryStatSync(dirPath);
    if (dirStat?.isDirectory()) {
      if (possibleJsToTs) {
        const fileExt = path.extname(file);
        const fileName = file.slice(0, -fileExt.length);
        if (
          (res = tryResolveRealFile(
            fileName + fileExt.replace("js", "ts"),
            preserveSymlinks
          ))
        )
          return res;
        // for .js, also try .tsx
        if (
          fileExt === ".js" &&
          (res = tryResolveRealFile(fileName + ".tsx", preserveSymlinks))
        )
          return res;
      }

      if (
        (res = tryResolveRealFileWithExtensions(
          file,
          extensions,
          preserveSymlinks
        ))
      )
        return res;

      if (tryPrefix) {
        const prefixed = `${dirPath}/${options.tryPrefix}${path.basename(
          file
        )}`;

        if ((res = tryResolveRealFile(prefixed, preserveSymlinks))) return res;

        if (
          (res = tryResolveRealFileWithExtensions(
            prefixed,
            extensions,
            preserveSymlinks
          ))
        )
          return res;
      }
    }
  }

  if (tryIndex && fileStat) {
    const dirPath = file;

    if (!skipPackageJson) {
      let pkgPath = `${dirPath}/package.json`;
      try {
        if (fs.existsSync(pkgPath)) {
          if (!options.preserveSymlinks) {
            pkgPath = safeRealpathSync(pkgPath);
          }
          const pkg = loadPackageData(pkgPath);
          return resolvePackageEntry(dirPath, pkg, targetWeb, options);
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }

    if (
      (res = tryResolveRealFileWithExtensions(
        `${dirPath}/index`,
        extensions,
        preserveSymlinks
      ))
    )
      return res;

    if (tryPrefix) {
      if (
        (res = tryResolveRealFileWithExtensions(
          `${dirPath}/${options.tryPrefix}index`,
          extensions,
          preserveSymlinks
        ))
      )
        return res;
    }
  }
}

function tryResolveRealFile(
  file: string,
  preserveSymlinks: boolean
): string | undefined {
  const stat = tryStatSync(file);
  if (stat?.isFile()) return getRealPath(file, preserveSymlinks);
}
