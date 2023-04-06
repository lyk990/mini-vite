import cac from "cac";
const cli = cac();
cli
  .command("[root]", "Run the development server")
  .alias("serve")
  .alias("dev")
  .action(async () => {
    const { createServer } = await import("./server");
    createServer();
  });

cli.help();

cli.parse();
