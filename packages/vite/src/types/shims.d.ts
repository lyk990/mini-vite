declare var __vite_start_time: number | undefined;

declare module "postcss-import" {
  import type { Plugin } from "postcss";
  const plugin: (options: {
    resolve: (
      id: string,
      basedir: string,
      importOptions: any
    ) => string | string[] | Promise<string | string[]>;
    nameLayer: (index: number, rootFilename: string) => string;
  }) => Plugin;
  export = plugin;
}
