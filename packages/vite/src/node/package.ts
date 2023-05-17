import { Plugin } from "vite";
import { createFilter, isInNodeModules, safeRealpathSync } from "./utils";
import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";

// @ts-ignore eslint-disable-next-line @typescript-eslint/consistent-type-imports
let pnp: typeof import("pnpapi") | undefined;
if (process.versions.pnp) {
  try {
    pnp = createRequire(import.meta.url)("pnpapi");
  } catch(e) {console.log(e);}
}
export type PackageCache = Map<string, PackageData>;
export interface PackageData {
  dir: string;
  hasSideEffects: (id: string) => boolean | "no-treeshake";
  webResolvedImports: Record<string, string | undefined>;
  nodeResolvedImports: Record<string, string | undefined>;
  setResolvedCache: (key: string, entry: string, targetWeb: boolean) => void;
  getResolvedCache: (key: string, targetWeb: boolean) => string | undefined;
  data: {
    [field: string]: any;
    name: string;
    type: string;
    version: string;
    main: string;
    module: string;
    browser: string | Record<string, string | false>;
    exports: string | Record<string, any> | string[];
    imports: Record<string, any>;
    dependencies: Record<string, string>;
  };
}

/**监听package.json文件得改变 */
export function watchPackageDataPlugin(packageCache: PackageCache): Plugin {
  const watchQueue = new Set<string>();
  const watchedDirs = new Set<string>();

  const watchFileStub = (id: string) => {
    watchQueue.add(id);
  };
  let watchFile = watchFileStub;

  const setPackageData = packageCache.set.bind(packageCache);
  packageCache.set = (id, pkg) => {
    if (!isInNodeModules(pkg.dir) && !watchedDirs.has(pkg.dir)) {
      watchedDirs.add(pkg.dir);
      watchFile(path.join(pkg.dir, "package.json"));
    }
    return setPackageData(id, pkg);
  };

  return {
    name: "vite:watch-package-data",
    buildStart() {
      watchFile = this.addWatchFile.bind(this);
      watchQueue.forEach(watchFile);
      watchQueue.clear();
    },
    buildEnd() {
      watchFile = watchFileStub;
    },
    watchChange(id) {
      if (id.endsWith("/package.json")) {
        invalidatePackageData(packageCache, path.normalize(id));
      }
    },
    handleHotUpdate({ file }) {
      if (file.endsWith("/package.json")) {
        invalidatePackageData(packageCache, path.normalize(file));
      }
    },
  };
}

function invalidatePackageData(
  packageCache: PackageCache,
  pkgPath: string
): void {
  const pkgDir = path.dirname(pkgPath);
  packageCache.forEach((pkg, cacheKey) => {
    if (pkg.dir === pkgDir) {
      packageCache.delete(cacheKey);
    }
  });
}

function getRpdCacheKey(
  pkgName: string,
  basedir: string,
  preserveSymlinks: boolean
) {
  return `rpd_${pkgName}_${basedir}_${preserveSymlinks}`;
}

export function resolvePackageData(
  pkgName: string,
  basedir: string,
  preserveSymlinks = false,
  packageCache?: PackageCache
): PackageData | null {
  if (pnp) {
    const cacheKey = getRpdCacheKey(pkgName, basedir, preserveSymlinks);
    if (packageCache?.has(cacheKey)) return packageCache.get(cacheKey)!;

    let pkg: string | null;
    try {
      pkg = pnp.resolveToUnqualified(pkgName, basedir, {
        considerBuiltins: false,
      });
    } catch(e) {
      console.log(e);
      return null;
    }
    if (!pkg) return null;

    const pkgData = loadPackageData(path.join(pkg, "package.json"));
    packageCache?.set(cacheKey, pkgData);

    return pkgData;
  }

  const originalBasedir = basedir;
  while (basedir) {
    if (packageCache) {
      const cached = getRpdCache(
        packageCache,
        pkgName,
        basedir,
        originalBasedir,
        preserveSymlinks
      );
      if (cached) return cached;
    }

    const pkg = path.join(basedir, "node_modules", pkgName, "package.json");
    try {
      if (fs.existsSync(pkg)) {
        const pkgPath = preserveSymlinks ? pkg : safeRealpathSync(pkg);
        const pkgData = loadPackageData(pkgPath);

        if (packageCache) {
          setRpdCache(
            packageCache,
            pkgData,
            pkgName,
            basedir,
            originalBasedir,
            preserveSymlinks
          );
        }

        return pkgData;
      }
    } catch(e) {console.log(e);}

    const nextBasedir = path.dirname(basedir);
    if (nextBasedir === basedir) break;
    basedir = nextBasedir;
  }

  return null;
}

export function findNearestMainPackageData(
  basedir: string,
  packageCache?: PackageCache
): PackageData | null {
  const nearestPackage = findNearestPackageData(basedir, packageCache);
  return (
    nearestPackage &&
    (nearestPackage.data.name
      ? nearestPackage
      : findNearestMainPackageData(
          path.dirname(nearestPackage.dir),
          packageCache
        ))
  );
}

export function loadPackageData(pkgPath: string): PackageData {
  const data = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const pkgDir = path.dirname(pkgPath);
  const { sideEffects } = data;
  let hasSideEffects: (id: string) => boolean;
  if (typeof sideEffects === "boolean") {
    hasSideEffects = () => sideEffects;
  } else if (Array.isArray(sideEffects)) {
    const finalPackageSideEffects = sideEffects.map((sideEffect) => {
      if (sideEffect.includes("/")) {
        return sideEffect;
      }
      return `**/${sideEffect}`;
    });

    hasSideEffects = createFilter(finalPackageSideEffects, null, {
      resolve: pkgDir,
    });
  } else {
    hasSideEffects = () => true;
  }

  const pkg: PackageData = {
    dir: pkgDir,
    data,
    hasSideEffects,
    webResolvedImports: {},
    nodeResolvedImports: {},
    setResolvedCache(key: string, entry: string, targetWeb: boolean) {
      if (targetWeb) {
        pkg.webResolvedImports[key] = entry;
      } else {
        pkg.nodeResolvedImports[key] = entry;
      }
    },
    getResolvedCache(key: string, targetWeb: boolean) {
      if (targetWeb) {
        return pkg.webResolvedImports[key];
      } else {
        return pkg.nodeResolvedImports[key];
      }
    },
  };

  return pkg;
}

function getRpdCache(
  packageCache: PackageCache,
  pkgName: string,
  basedir: string,
  originalBasedir: string,
  preserveSymlinks: boolean
) {
  const cacheKey = getRpdCacheKey(pkgName, basedir, preserveSymlinks);
  const pkgData = packageCache.get(cacheKey);
  if (pkgData) {
    traverseBetweenDirs(originalBasedir, basedir, (dir) => {
      packageCache.set(getRpdCacheKey(pkgName, dir, preserveSymlinks), pkgData);
    });
    return pkgData;
  }
}

function traverseBetweenDirs(
  longerDir: string,
  shorterDir: string,
  cb: (dir: string) => void
) {
  while (longerDir !== shorterDir) {
    cb(longerDir);
    longerDir = path.dirname(longerDir);
  }
}

export function findNearestPackageData(
  basedir: string,
  packageCache?: PackageCache
): PackageData | null {
  const originalBasedir = basedir;
  while (basedir) {
    if (packageCache) {
      const cached = getFnpdCache(packageCache, basedir, originalBasedir);
      if (cached) return cached;
    }

    const pkgPath = path.join(basedir, "package.json");
    try {
      if (fs.statSync(pkgPath, { throwIfNoEntry: false })?.isFile()) {
        const pkgData = loadPackageData(pkgPath);

        if (packageCache) {
          setFnpdCache(packageCache, pkgData, basedir, originalBasedir);
        }

        return pkgData;
      }
    } catch(e) {console.log(e);}

    const nextBasedir = path.dirname(basedir);
    if (nextBasedir === basedir) break;
    basedir = nextBasedir;
  }

  return null;
}

function getFnpdCache(
  packageCache: PackageCache,
  basedir: string,
  originalBasedir: string
) {
  const cacheKey = getFnpdCacheKey(basedir);
  const pkgData = packageCache.get(cacheKey);
  if (pkgData) {
    traverseBetweenDirs(originalBasedir, basedir, (dir) => {
      packageCache.set(getFnpdCacheKey(dir), pkgData);
    });
    return pkgData;
  }
}

function getFnpdCacheKey(basedir: string) {
  return `fnpd_${basedir}`;
}

function setFnpdCache(
  packageCache: PackageCache,
  pkgData: PackageData,
  basedir: string,
  originalBasedir: string
) {
  packageCache.set(getFnpdCacheKey(basedir), pkgData);
  traverseBetweenDirs(originalBasedir, basedir, (dir) => {
    packageCache.set(getFnpdCacheKey(dir), pkgData);
  });
}

function setRpdCache(
  packageCache: PackageCache,
  pkgData: PackageData,
  pkgName: string,
  basedir: string,
  originalBasedir: string,
  preserveSymlinks: boolean
) {
  packageCache.set(getRpdCacheKey(pkgName, basedir, preserveSymlinks), pkgData);
  traverseBetweenDirs(originalBasedir, basedir, (dir) => {
    packageCache.set(getRpdCacheKey(pkgName, dir, preserveSymlinks), pkgData);
  });
}
