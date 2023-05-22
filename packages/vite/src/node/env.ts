// DELETE
// import { UserConfig } from "vite";
// import { arraify } from "./utils";
// import path from "node:path";
// import { parse } from "dotenv";
// import fs from "node:fs";
// import { expand } from "dotenv-expand";

// export function loadEnv(
//   mode: string,
//   envDir: string,
//   prefixes: string | string[] = "VITE_"
// ): Record<string, string> {
//   if (mode === "local") {
//     throw new Error(
//       `"local" cannot be used as a mode name because it conflicts with ` +
//         `the .local postfix for .env files.`
//     );
//   }
//   prefixes = arraify(prefixes);
//   const env: Record<string, string> = {};
//   const envFiles = [
//     /** default file */ `.env`,
//     /** local file */ `.env.local`,
//     /** mode file */ `.env.${mode}`,
//     /** mode local file */ `.env.${mode}.local`,
//   ];

//   const parsed = Object.fromEntries(
//     envFiles.flatMap((file) => {
//       const filePath = path.join(envDir, file);
//       if (!tryStatSync(filePath)?.isFile()) return [];

//       return Object.entries(parse(fs.readFileSync(filePath)));
//     })
//   );
//   // test NODE_ENV override before expand as otherwise process.env.NODE_ENV would override this
//   if (parsed.NODE_ENV && process.env.VITE_USER_NODE_ENV === undefined) {
//     process.env.VITE_USER_NODE_ENV = parsed.NODE_ENV;
//   }
//   if (parsed.BROWSER && process.env.BROWSER === undefined) {
//     process.env.BROWSER = parsed.BROWSER;
//   }
//   if (parsed.BROWSER_ARGS && process.env.BROWSER_ARGS === undefined) {
//     process.env.BROWSER_ARGS = parsed.BROWSER_ARGS;
//   }

//   expand({ parsed });

//   for (const [key, value] of Object.entries(parsed)) {
//     if (prefixes.some((prefix) => key.startsWith(prefix))) {
//       env[key] = value;
//     }
//   }

//   for (const key in process.env) {
//     if (prefixes.some((prefix) => key.startsWith(prefix))) {
//       env[key] = process.env[key] as string;
//     }
//   }

//   return env;
// }

// export function resolveEnvPrefix({
//   envPrefix = "VITE_",
// }: UserConfig): string[] {
//   envPrefix = arraify(envPrefix);
//   if (envPrefix.some((prefix) => prefix === "")) {
//     throw new Error(
//       `envPrefix option contains value '', which could lead unexpected exposure of sensitive information.`
//     );
//   }
//   return envPrefix;
// }
