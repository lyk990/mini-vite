import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import MagicString from "magic-string";
import type { Plugin, RollupOptions } from "rollup";
import { defineConfig } from "rollup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url)).toString()
);

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const envConfig = defineConfig({
  input: path.resolve(__dirname, "src/client/env.ts"),
  plugins: [
    typescript({
      tsconfig: path.resolve(__dirname, "src/client/tsconfig.json"),
    }),
  ],
  output: {
    file: path.resolve(__dirname, "dist/client", "env.mjs"),
    sourcemap: true,
    sourcemapPathTransform(relativeSourcePath) {
      return path.basename(relativeSourcePath);
    },
    sourcemapIgnoreList() {
      return true;
    },
  },
});

const clientConfig = defineConfig({
  input: path.resolve(__dirname, "src/client/client.ts"),
  external: ["./env", "@vite/env"],
  plugins: [
    typescript({
      tsconfig: path.resolve(__dirname, "src/client/tsconfig.json"),
    }),
  ],
  output: {
    file: path.resolve(__dirname, "dist/client", "client.mjs"),
    sourcemap: true,
    sourcemapPathTransform(relativeSourcePath) {
      return path.basename(relativeSourcePath);
    },
    sourcemapIgnoreList() {
      return true;
    },
  },
});

const sharedNodeOptions = defineConfig({
  treeshake: {
    moduleSideEffects: "no-external",
    propertyReadSideEffects: false,
    tryCatchDeoptimization: false,
  },
  output: {
    dir: "./dist",
    entryFileNames: `node/[name].js`,
    chunkFileNames: "node/chunks/dep-[hash].js",
    exports: "named",
    format: "esm",
    externalLiveBindings: false,
    freeze: false,
  },
  onwarn(warning, warn) {
    if (warning.message.includes("Circular dependency")) {
      return;
    }
    warn(warning);
  },
});

function createNodePlugins(
  isProduction: boolean,
  sourceMap: boolean,
  declarationDir: string | false
): (Plugin | false)[] {
  return [
    nodeResolve({ preferBuiltins: true }),
    typescript({
      tsconfig: path.resolve(__dirname, "src/node/tsconfig.json"),
      sourceMap,
      declaration: declarationDir !== false,
      declarationDir: declarationDir !== false ? declarationDir : undefined,
    }),

    isProduction &&
      shimDepsPlugin({
        "fsevents-handler.js": {
          src: `require('fsevents')`,
          replacement: `__require('fsevents')`,
        },
        "process-content.js": {
          src: 'require("sugarss")',
          replacement: `__require('sugarss')`,
        },
        "lilconfig/dist/index.js": {
          pattern: /: require,/g,
          replacement: `: __require,`,
        },
        "postcss-load-config/src/index.js": {
          pattern: /require(?=\((configFile|'ts-node')\))/g,
          replacement: `__require`,
        },
        "json-stable-stringify/index.js": {
          pattern: /^var json = typeof JSON.+require\('jsonify'\);$/gm,
          replacement: "var json = JSON",
        },
      }),

    commonjs({
      extensions: [".js"],
      ignore: ["bufferutil", "utf-8-validate"],
    }),
    json(),
  ];
}

function createNodeConfig(isProduction: boolean) {
  return defineConfig({
    ...sharedNodeOptions,
    input: {
      index: path.resolve(__dirname, "src/node/index.ts"),
      cli: path.resolve(__dirname, "src/node/cli.ts"),
      constants: path.resolve(__dirname, "src/node/constants.ts"),
    },
    output: {
      ...sharedNodeOptions.output,
      sourcemap: !isProduction,
    },
    external: [
      "fsevents",
      ...Object.keys(pkg.dependencies),
      ...(isProduction ? [] : Object.keys(pkg.devDependencies)),
    ],
    plugins: createNodePlugins(
      isProduction,
      !isProduction,
      isProduction ? false : "./dist/node"
    ),
  });
}

export default (commandLineArgs: any): RollupOptions[] => {
  const isDev = commandLineArgs.watch;
  const isProduction = !isDev;

  return defineConfig([
    envConfig,
    clientConfig,
    createNodeConfig(isProduction),
  ]);
};

interface ShimOptions {
  src?: string;
  replacement: string;
  pattern?: RegExp;
}

function shimDepsPlugin(deps: Record<string, ShimOptions>): Plugin {
  const transformed: Record<string, boolean> = {};

  return {
    name: "shim-deps",
    transform(code, id) {
      for (const file in deps) {
        if (id.replace(/\\/g, "/").endsWith(file)) {
          const { src, replacement, pattern } = deps[file];

          const magicString = new MagicString(code);
          if (src) {
            const pos = code.indexOf(src);
            if (pos < 0) {
              this.error(
                `Could not find expected src "${src}" in file "${file}"`
              );
            }
            transformed[file] = true;
            magicString.overwrite(pos, pos + src.length, replacement);
            console.log(`shimmed: ${file}`);
          }

          if (pattern) {
            let match;
            while ((match = pattern.exec(code))) {
              transformed[file] = true;
              const start = match.index;
              const end = start + match[0].length;
              magicString.overwrite(start, end, replacement);
            }
            if (!transformed[file]) {
              this.error(
                `Could not find expected pattern "${pattern}" in file "${file}"`
              );
            }
            console.log(`shimmed: ${file}`);
          }

          return {
            code: magicString.toString(),
            map: magicString.generateMap({ hires: true }),
          };
        }
      }
    },
    buildEnd(err) {
      if (!err) {
        for (const file in deps) {
          if (!transformed[file]) {
            this.error(
              `Did not find "${file}" which is supposed to be shimmed, was the file renamed?`
            );
          }
        }
      }
    },
  };
}
