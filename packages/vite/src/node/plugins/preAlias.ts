import fs from "node:fs";
import path from "node:path";
import type {
  Alias,
  AliasOptions,
  DepOptimizationOptions,
  ResolvedConfig,
} from "..";
import type { Plugin } from "../plugin";
import { createIsConfiguredAsSsrExternal } from "../ssr/ssrExternal";
import {
  bareImportRE,
  cleanUrl,
  isInNodeModules,
  isOptimizable,
  moduleListContains,
} from "../utils";
import { getDepsOptimizer } from "../optimizer";
import { tryOptimizedResolve } from "./resolve";

export function preAliasPlugin(config: ResolvedConfig): Plugin {
  const findPatterns = getAliasPatterns(config.resolve.alias);
  const isConfiguredAsExternal = createIsConfiguredAsSsrExternal(config);
  const isBuild = config.command === "build";
  return {
    name: "vite:pre-alias",
    async resolveId(id, importer, options) {
      const ssr = options?.ssr === true;
      const depsOptimizer = getDepsOptimizer(config, ssr);
      if (
        importer &&
        depsOptimizer &&
        bareImportRE.test(id) &&
        !options?.scan &&
        id !== "@vite/client" &&
        id !== "@vite/env"
      ) {
        if (findPatterns.find((pattern) => matches(pattern, id))) {
          const optimizedId = await tryOptimizedResolve(
            depsOptimizer,
            id,
            importer,
            config.resolve.preserveSymlinks,
            config.packageCache
          );
          if (optimizedId) {
            return optimizedId;
          }
          if (depsOptimizer.options.noDiscovery) {
            return;
          }
          const resolved = await this.resolve(id, importer, {
            ...options,
            custom: { ...options.custom, "vite:pre-alias": true },
            skipSelf: true,
          });
          if (resolved && !depsOptimizer.isOptimizedDepFile(resolved.id)) {
            const optimizeDeps = depsOptimizer.options;
            const resolvedId = cleanUrl(resolved.id);
            const isVirtual = resolvedId === id || resolvedId.includes("\0");
            if (
              !isVirtual &&
              fs.existsSync(resolvedId) &&
              !moduleListContains(optimizeDeps.exclude, id) &&
              path.isAbsolute(resolvedId) &&
              (isInNodeModules(resolvedId) ||
                optimizeDeps.include?.includes(id)) &&
              isOptimizable(resolvedId, optimizeDeps) &&
              !(isBuild && ssr && isConfiguredAsExternal(id)) &&
              (!ssr || optimizeAliasReplacementForSSR(resolvedId, optimizeDeps))
            ) {
              const optimizedInfo = depsOptimizer!.registerMissingImport(
                id,
                resolvedId
              );
              return { id: depsOptimizer!.getOptimizedDepId(optimizedInfo) };
            }
          }
          return resolved;
        }
      }
    },
  };
}

function optimizeAliasReplacementForSSR(
  id: string,
  optimizeDeps: DepOptimizationOptions
) {
  if (optimizeDeps.include?.includes(id)) {
    return true;
  }
  return false;
}

function matches(pattern: string | RegExp, importee: string) {
  if (pattern instanceof RegExp) {
    return pattern.test(importee);
  }
  if (importee.length < pattern.length) {
    return false;
  }
  if (importee === pattern) {
    return true;
  }
  return importee.startsWith(pattern + "/");
}

function getAliasPatterns(
  entries: (AliasOptions | undefined) & Alias[]
): (string | RegExp)[] {
  if (!entries) {
    return [];
  }
  if (Array.isArray(entries)) {
    return entries.map((entry) => entry.find);
  }
  return Object.entries(entries).map(([find]) => find);
}
