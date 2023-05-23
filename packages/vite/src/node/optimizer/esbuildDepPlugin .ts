import { ResolvedConfig } from "../config";
import type { Plugin } from "esbuild";
import { CSS_LANGS_RE, KNOWN_ASSET_TYPES } from "../constants";
import { PackageCache } from "../packages";
import {
  flattenId,
  // isBuiltin,
  // isExternalUrl,
  moduleListContains,
  // normalizePath,
} from "../utils";
// import path from "node:path";
// import { browserExternalId, optionalPeerDepId } from "../plugins/resolve";

const convertedExternalPrefix = "vite-dep-pre-bundle-external:";

const externalWithConversionNamespace =
  "vite:dep-pre-bundle:external-conversion";

const externalTypes = [
  "css",
  "less",
  "sass",
  "scss",
  "styl",
  "stylus",
  "pcss",
  "postcss",
  "wasm",
  "vue",
  "svelte",
  "marko",
  "astro",
  "imba",
  "jsx",
  "tsx",
  ...KNOWN_ASSET_TYPES,
];

// DELETE
export function esbuildDepPlugin(
  qualified: Record<string, string>,
  external: string[],
  config: ResolvedConfig
  // ssr: boolean
): Plugin {
  const allExternalTypes = externalTypes;

  const esmPackageCache: PackageCache = new Map();
  const cjsPackageCache: PackageCache = new Map();

  const _resolve = config.createResolver({
    asSrc: false,
    scan: true,
    packageCache: esmPackageCache,
  });

  // const _resolveRequire = config.createResolver({
  //   asSrc: false,
  //   isRequire: true,
  //   scan: true,
  //   packageCache: cjsPackageCache,
  // });

  // const resolve = (
  //   id: string,
  //   importer: string,
  //   kind: ImportKind,
  //   resolveDir?: string
  // ): Promise<string | undefined> => {
  //   let _importer: string;
  //   if (resolveDir) {
  //     _importer = normalizePath(path.join(resolveDir, "*"));
  //   } else {
  //     _importer = importer in qualified ? qualified[importer] : importer;
  //   }
  //   const resolver = kind.startsWith("require") ? _resolveRequire : _resolve;
  //   return resolver(id, _importer, undefined, ssr);
  // };

  // const resolveResult = (id: string, resolved: string) => {
  //   if (resolved.startsWith(browserExternalId)) {
  //     return {
  //       path: id,
  //       namespace: "browser-external",
  //     };
  //   }
  //   if (resolved.startsWith(optionalPeerDepId)) {
  //     return {
  //       path: resolved,
  //       namespace: "optional-peer-dep",
  //     };
  //   }
  //   // if (ssr && isBuiltin(resolved)) {
  //   //   return;
  //   // }
  //   if (isExternalUrl(resolved)) {
  //     return {
  //       path: resolved,
  //       external: true,
  //     };
  //   }
  //   return {
  //     path: path.resolve(resolved),
  //   };
  // };

  return {
    name: "vite:dep-pre-bundle",
    setup(build) {
      build.onEnd(() => {
        esmPackageCache.clear();
        cjsPackageCache.clear();
      });

      build.onResolve(
        {
          filter: new RegExp(
            `\\.(` + allExternalTypes.join("|") + `)(\\?.*)?$`
          ),
        },
        async ({ path: id, importer, kind }) => {
          if (id.startsWith(convertedExternalPrefix)) {
            return {
              path: id.slice(convertedExternalPrefix.length),
              external: true,
            };
          }

          // const resolved = await resolve(id, importer, kind);
          // if (resolved) {
          //   // if (kind === "require-call") {
          //   //   return {
          //   //     path: resolved,
          //   //     namespace: externalWithConversionNamespace,
          //   //   };
          //   // }
          //   return {
          //     path: resolved,
          //     external: true,
          //   };
          // }
        }
      );
      build.onLoad(
        { filter: /./, namespace: externalWithConversionNamespace },
        (args) => {
          const modulePath = `"${convertedExternalPrefix}${args.path}"`;
          return {
            contents: CSS_LANGS_RE.test(args.path)
              ? `import ${modulePath};`
              : `export { default } from ${modulePath};` +
                `export * from ${modulePath};`,
            loader: "js",
          };
        }
      );

      function resolveEntry(id: string) {
        const flatId = flattenId(id);
        if (flatId in qualified) {
          return {
            path: qualified[flatId],
          };
        }
      }

      build.onResolve(
        { filter: /^[\w@][^:]/ },
        async ({ path: id, importer, kind }) => {
          if (moduleListContains(external, id)) {
            return {
              path: id,
              external: true,
            };
          }

          let entry: { path: string } | undefined;
          if (!importer) {
            if ((entry = resolveEntry(id))) return entry;
            const aliased = await _resolve(id, undefined, true);
            if (aliased && (entry = resolveEntry(aliased))) {
              return entry;
            }
          }

          // const resolved = await resolve(id, importer, kind);
          // if (resolved) {
          //   return resolveResult(id, resolved);
          // }
        }
      );

      build.onLoad(
        { filter: /.*/, namespace: "browser-external" },
        ({ path }) => {
          // if (config.isProduction) {
          //   return {
          //     contents: "module.exports = {}",
          //   };
          // } else {
          return {
            contents: `\
module.exports = Object.create(new Proxy({}, {
  get(_, key) {
    if (
      key !== '__esModule' &&
      key !== '__proto__' &&
      key !== 'constructor' &&
      key !== 'splice'
    ) {
      console.warn(\`Module "${path}" has been externalized for browser compatibility. Cannot access "${path}.\${key}" in client code. See http://vitejs.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.\`)
    }
  }
}))`,
          };
          // }
        }
      );

      build.onLoad(
        { filter: /.*/, namespace: "optional-peer-dep" },
        ({ path }) => {
          // if (config.isProduction) {
          //   return {
          //     contents: "module.exports = {}",
          //   };
          // } else {
          const [, peerDep, parentDep] = path.split(":");
          return {
            contents: `throw new Error(\`Could not resolve "${peerDep}" imported by "${parentDep}". Is it installed?\`)`,
          };
          // }
        }
      );
    },
  };
}
