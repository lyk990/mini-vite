import { InlineConfig, UserConfigExport } from "vite";

export async function resolveConfig(
  inlineConfig: InlineConfig,
  command: "build" | "serve",
  defaultMode = "development",
  defaultNodeEnv = "development"
) {}

export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config;
}
