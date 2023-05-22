import cac from "cac";
import colors from "picocolors";
import { performance } from "node:perf_hooks";
import { VERSION } from "./constants";
import { createLogger } from "vite";

const cli = cac("mini-vite");
cli
  .command("[root]", "Run the development server")
  .option("--dev", `development`)
  .option("--prod", `production`)
  .option("--port <port>", `[number] specify port`)
  .action(async (root, options) => {
    const { createServer } = await import("./server");
    try {
      const server = await createServer({
        root,
        base: options.base,
        mode: options.mode,
        configFile: options.config,
        logLevel: options.logLevel,
        clearScreen: options.clearScreen,
        optimizeDeps: { force: options.force },
        server: {},
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
