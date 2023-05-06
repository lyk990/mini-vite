import fs from "node:fs";
import path from "node:path";
import { createFilter } from "./utils";

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
    } catch {}

    const nextBasedir = path.dirname(basedir);
    if (nextBasedir === basedir) break;
    basedir = nextBasedir;
  }

  return null;
}

function getFnpdCacheKey(basedir: string) {
  return `fnpd_${basedir}`;
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
