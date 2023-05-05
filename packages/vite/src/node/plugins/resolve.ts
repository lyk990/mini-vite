import { InternalResolveOptions } from "vite";
import { Plugin } from "../plugin";

export type InternalResolveOptionsWithOverrideConditions =
  InternalResolveOptions & {
    overrideConditions?: string[];
  };

export function resolvePlugin(resolveOptions?: InternalResolveOptions): Plugin {
  return {} as Plugin;
}
//TODO
// export function tryNodeResolve(
//   id: string,
//   importer: string | null | undefined,
//   options: InternalResolveOptionsWithOverrideConditions,
//   targetWeb: boolean,
//   depsOptimizer?: DepsOptimizer,
//   ssr: boolean = false,
//   externalize?: boolean,
//   allowLinkedExternal: boolean = true
// ): PartialResolvedId | undefined {
//   const { root, dedupe, isBuild, preserveSymlinks, packageCache } = options;

//   // check for deep import, e.g. "my-lib/foo"
//   const deepMatch = id.match(deepImportRE);
//   const pkgId = deepMatch ? deepMatch[1] || deepMatch[2] : id;

//   let basedir: string;
//   if (dedupe?.includes(pkgId)) {
//     basedir = root;
//   } else if (
//     importer &&
//     path.isAbsolute(importer) &&
//     // css processing appends `*` for importer
//     (importer[importer.length - 1] === "*" || fs.existsSync(cleanUrl(importer)))
//   ) {
//     basedir = path.dirname(importer);
//   } else {
//     basedir = root;
//   }

//   const pkg = resolvePackageData(
//     pkgId,
//     basedir,
//     preserveSymlinks,
//     packageCache
//   );
//   if (!pkg) {
//     // if import can't be found, check if it's an optional peer dep.
//     // if so, we can resolve to a special id that errors only when imported.
//     if (
//       basedir !== root && // root has no peer dep
//       !isBuiltin(id) &&
//       !id.includes("\0") &&
//       bareImportRE.test(id)
//     ) {
//       const mainPkg = findNearestMainPackageData(basedir, packageCache)?.data;
//       if (mainPkg) {
//         if (
//           mainPkg.peerDependencies?.[id] &&
//           mainPkg.peerDependenciesMeta?.[id]?.optional
//         ) {
//           return {
//             id: `${optionalPeerDepId}:${id}:${mainPkg.name}`,
//           };
//         }
//       }
//     }
//     return;
//   }

//   const resolveId = deepMatch ? resolveDeepImport : resolvePackageEntry;
//   const unresolvedId = deepMatch ? "." + id.slice(pkgId.length) : pkgId;

//   let resolved: string | undefined;
//   try {
//     resolved = resolveId(unresolvedId, pkg, targetWeb, options);
//   } catch (err) {
//     if (!options.tryEsmOnly) {
//       throw err;
//     }
//   }
//   if (!resolved && options.tryEsmOnly) {
//     resolved = resolveId(unresolvedId, pkg, targetWeb, {
//       ...options,
//       isRequire: false,
//       mainFields: DEFAULT_MAIN_FIELDS,
//       extensions: DEFAULT_EXTENSIONS,
//     });
//   }
//   if (!resolved) {
//     return;
//   }

//   const processResult = (resolved: PartialResolvedId) => {
//     if (!externalize) {
//       return resolved;
//     }
//     // don't external symlink packages
//     if (!allowLinkedExternal && !isInNodeModules(resolved.id)) {
//       return resolved;
//     }
//     const resolvedExt = path.extname(resolved.id);
//     // don't external non-js imports
//     if (
//       resolvedExt &&
//       resolvedExt !== ".js" &&
//       resolvedExt !== ".mjs" &&
//       resolvedExt !== ".cjs"
//     ) {
//       return resolved;
//     }
//     let resolvedId = id;
//     if (deepMatch && !pkg?.data.exports && path.extname(id) !== resolvedExt) {
//       const index = resolved.id.indexOf(id);
//       if (index > -1) {
//         resolvedId = resolved.id.slice(index);
//         debug?.(
//           `[processResult] ${colors.cyan(id)} -> ${colors.dim(resolvedId)}`
//         );
//       }
//     }
//     return { ...resolved, id: resolvedId, external: true };
//   };

//   if (
//     !options.idOnly &&
//     ((!options.scan && isBuild && !depsOptimizer) || externalize)
//   ) {
//     return processResult({
//       id: resolved,
//       moduleSideEffects: pkg.hasSideEffects(resolved),
//     });
//   }

//   const ext = path.extname(resolved);

//   if (
//     !options.ssrOptimizeCheck &&
//     (!isInNodeModules(resolved) || !depsOptimizer || options.scan)
//   ) {
//     return { id: resolved };
//   }

//   const isJsType = depsOptimizer
//     ? isOptimizable(resolved, depsOptimizer.options)
//     : OPTIMIZABLE_ENTRY_RE.test(resolved);

//   let exclude = depsOptimizer?.options.exclude;
//   let include = depsOptimizer?.options.include;
//   if (options.ssrOptimizeCheck) {
//     exclude = options.ssrConfig?.optimizeDeps?.exclude;
//     include = options.ssrConfig?.optimizeDeps?.include;
//   }

//   const skipOptimization =
//     depsOptimizer?.options.noDiscovery ||
//     !isJsType ||
//     (importer && isInNodeModules(importer)) ||
//     exclude?.includes(pkgId) ||
//     exclude?.includes(id) ||
//     SPECIAL_QUERY_RE.test(resolved) ||
//     (!options.ssrOptimizeCheck && !isBuild && ssr) ||
//     (ssr &&
//       !(
//         ext === ".cjs" ||
//         (ext === ".js" &&
//           findNearestPackageData(path.dirname(resolved), options.packageCache)
//             ?.data.type !== "module")
//       ) &&
//       !(include?.includes(pkgId) || include?.includes(id)));

//   if (options.ssrOptimizeCheck) {
//     return {
//       id: skipOptimization
//         ? injectQuery(resolved, `__vite_skip_optimization`)
//         : resolved,
//     };
//   }

//   if (skipOptimization) {
//     if (!isBuild) {
//       const versionHash = depsOptimizer!.metadata.browserHash;
//       if (versionHash && isJsType) {
//         resolved = injectQuery(resolved, `v=${versionHash}`);
//       }
//     }
//   } else {
//     const optimizedInfo = depsOptimizer!.registerMissingImport(id, resolved);
//     resolved = depsOptimizer!.getOptimizedDepId(optimizedInfo);
//   }

//   if (!options.idOnly && !options.scan && isBuild) {
//     // Resolve package side effects for build so that rollup can better
//     // perform tree-shaking
//     return {
//       id: resolved,
//       moduleSideEffects: pkg.hasSideEffects(resolved),
//     };
//   } else {
//     return { id: resolved! };
//   }
// }
