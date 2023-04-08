import cac from "cac";
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
    } catch (error) {}
  });

cli.help();

cli.parse();
