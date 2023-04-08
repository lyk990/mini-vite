import cac from "cac";
import colors from "picocolors";
import { performance } from "node:perf_hooks";
import { VERSION } from "./constants";
import type { LogLevel } from "./logger";
import { createLogger } from "vite";

interface GlobalCLIOptions {
  "--"?: string[];
  c?: boolean | string;
  config?: string;
  base?: string;
  l?: LogLevel;
  logLevel?: LogLevel;
  clearScreen?: boolean;
  d?: boolean | string;
  debug?: boolean | string;
  f?: string;
  filter?: string;
  m?: string;
  mode?: string;
  force?: boolean;
}
/**
 * removing global flags before passing as command specific sub-configs
 */
function cleanOptions<Options extends GlobalCLIOptions>(
  options: Options
): Omit<Options, keyof GlobalCLIOptions> {
  const ret = { ...options };
  delete ret["--"];
  delete ret.c;
  delete ret.config;
  delete ret.base;
  delete ret.l;
  delete ret.logLevel;
  delete ret.clearScreen;
  delete ret.d;
  delete ret.debug;
  delete ret.f;
  delete ret.filter;
  delete ret.m;
  delete ret.mode;
  return ret;
}

const cli = cac();
cli
  .command("[root]", "Run the development server")
  .option("--dev", `development`)
  .option("--prod", `production`)
  .action(async (_root, options) => {
    const { createServer } = await import("./server");
    try {
      const server = await createServer({
        mode: options.dev,
        server: cleanOptions(options),
      });
      if (!server.httpServer) {
        throw new Error("HTTP server not available");
      }
      await server.listen();
      const info = server.config.logger.info;
      const viteStartTime = global.__vite_start_time ?? false;
      const startupDurationString = viteStartTime
        ? colors.dim(
            `ready in ${colors.reset(
              colors.bold(Math.ceil(performance.now() - viteStartTime))
            )} ms`
          )
        : "";
      info(
        `\n  ${colors.green(
          `${colors.bold("MINI-VITE")} v${VERSION}`
        )}  ${startupDurationString}\n`,
        { clear: !server.config.logger.hasWarned }
      );
      server.printUrls();
    } catch (e) {
      const logger = createLogger(options.logLevel);
      logger.error(colors.red(`error when starting dev server:\n${e.stack}`), {
        error: e,
      });
      process.exit(1);
    }
  });

cli.help();

cli.parse();
