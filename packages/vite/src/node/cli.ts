import cac from "cac";
import colors from "picocolors";
import { performance } from "node:perf_hooks";
import { VERSION } from "./constants";

const cli = cac();
cli
  .command("[root]", "Run the development server")
  .option("--dev", `development`)
  .option("--prod", `production`)
  .action(async (_root, options) => {
    const { createServer } = await import("./server");
    try {
      const server = await createServer({ mode: options.dev });
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
    } catch (error) {}
  });

cli.help();

cli.parse();
