import { isCSSRequest } from "vite";
// import { ResolvedConfig } from "../config";
import { BARE_IMPORT_RE, CLIENT_PUBLIC_PATH } from "../constants";
// import { ViteDevServer } from "../server";
import { cleanUrl,  getShortName,  isJSRequest, normalizePath } from "../utils";
import path from "node:path";
import { ServerContext } from "../server";
import { Plugin } from "../plugin";
import { init, parse } from "es-module-lexer";
import MagicString from "magic-string";
// import { isDirectCSSRequest } from "./css";
// import { init, parse as parseImports } from "es-module-lexer";
// import colors from "picocolors";
// import type { ExportSpecifier, ImportSpecifier } from "es-module-lexer";
// import { getDepsOptimizer, optimizedDepNeedsInterop } from "../optimizer";
// import { getDepOptimizationConfig } from "../config";

// const skipRE = /\.(?:map|json)(?:$|\?)/;
// export const canSkipImportAnalysis = (id: string): boolean =>
//   skipRE.test(id) || isDirectCSSRequest(id);
// const debug = createDebugger("vite:import-analysis");

// TODO
/**注入热更新代码 import.meta.hot*/
export function importAnalysisPlugin(): Plugin {
  let serverContext: ServerContext;
  return {
    name: "m-vite:import-analysis",
    configureServer(s) {
      // @ts-ignore
      serverContext = s;
    },
    async transform(code: string, id: string) {
      if (!isJSRequest(id) || isInternalRequest(id)) {
        return null;
      }
      await init;
      const importedModules = new Set<string>();
      const [imports] = parse(code);
      const ms = new MagicString(code);
      const resolve = async (id: string, importer?: string) => {
        const resolved = await serverContext.pluginContainer.resolveId(
          id,
          // @ts-ignore
          normalizePath(importer)
        );
        if (!resolved) {
          return;
        }
        const cleanedId = cleanUrl(resolved.id);
        const mod = moduleGraph.getModuleById(cleanedId);
        let resolvedId = `/${getShortName(resolved.id, serverContext.root)}`;
        if (mod && mod.lastHMRTimestamp > 0) {
          // resolvedId += "?t=" + mod.lastHMRTimestamp;
        }
        return resolvedId;
      };
      const { moduleGraph } = serverContext;
      const curMod = moduleGraph.getModuleById(id)!;

      for (const importInfo of imports) {
        const { s: modStart, e: modEnd, n: modSource } = importInfo;
        if (!modSource || isInternalRequest(modSource)) continue;
        // 静态资源
        if (modSource.endsWith(".svg")) {
          // 加上 ?import 后缀
          const resolvedUrl = await resolve(modSource, id);
          ms.overwrite(modStart, modEnd, `${resolvedUrl}?import`);
          continue;
        }
        // 第三方库: 路径重写到预构建产物的路径
        if (BARE_IMPORT_RE.test(modSource)) {
          const bundlePath = normalizePath(
            path.join("/", PRE_BUNDLE_DIR, `${modSource}.js`)
          );
          ms.overwrite(modStart, modEnd, bundlePath);
          importedModules.add(bundlePath);
        } else if (modSource.startsWith(".") || modSource.startsWith("/")) {
          const resolved = await resolve(modSource, id);
          if (resolved) {
            ms.overwrite(modStart, modEnd, resolved);
            importedModules.add(resolved);
          }
        }
      }
      // 只对业务源码注入
      if (!id.includes("node_modules")) {
        // 注入 HMR 相关的工具函数
        ms.prepend(
          `import { createHotContext as __vite__createHotContext } from "${CLIENT_PUBLIC_PATH}";` +
            `import.meta.hot = __vite__createHotContext(${JSON.stringify(
              cleanUrl(curMod.url)
            )});`
        );
      }

      moduleGraph.updateModuleInfo(curMod, importedModules);

      return {
        code: ms.toString(),
        map: ms.generateMap(),
      };
    },
  };
}

export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(cleanUrl(url)) && !isCSSRequest(url);
}
