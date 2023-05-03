import { Plugin } from "vite";
import { PackageCache } from "vite";
import { isInNodeModules } from "./utils";
import path from "node:path";

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
  pkgPath: string,
): void {
  const pkgDir = path.dirname(pkgPath)
  packageCache.forEach((pkg, cacheKey) => {
    if (pkg.dir === pkgDir) {
      packageCache.delete(cacheKey)
    }
  })
}