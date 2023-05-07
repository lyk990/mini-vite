import { DepsOptimizer, SSROptions } from "vite";
import { PackageCache } from "../packages";
import { Plugin } from "../plugin";
import { createDebugger } from "../utils";

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
        // When injected directly in html/client code
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

  // check for deep import, e.g. "my-lib/foo"
  const deepMatch = id.match(deepImportRE);
  const pkgId = deepMatch ? deepMatch[1] || deepMatch[2] : id;

  let basedir: string;
  if (dedupe?.includes(pkgId)) {
    basedir = root;
  } else if (
    importer &&
    path.isAbsolute(importer) &&
    // css processing appends `*` for importer
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
    // if import can't be found, check if it's an optional peer dep.
    // if so, we can resolve to a special id that errors only when imported.
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
    // don't external symlink packages
    if (!allowLinkedExternal && !isInNodeModules(resolved.id)) {
      return resolved;
    }
    const resolvedExt = path.extname(resolved.id);
    // don't external non-js imports
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

  const skipOptimization =
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
    // Resolve package side effects for build so that rollup can better
    // perform tree-shaking
    return {
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved),
    };
  } else {
    return { id: resolved! };
  }
}
