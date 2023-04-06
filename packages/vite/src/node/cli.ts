import cac from "cac";
const cli = cac();
cli
  .command("[root]", "Run the development server")
  .alias("serve")
  .alias("dev")
  .action(async () => {
    console.log('测试 cli~');
  });

cli.help();

cli.parse();