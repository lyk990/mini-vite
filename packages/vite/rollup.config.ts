import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
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

