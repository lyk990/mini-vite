import { ModuleNode } from "vite";
import { ViteDevServer } from "../server";
import micromatch from "micromatch";

export function getAffectedGlobModules(
  file: string,
  server: ViteDevServer
): ModuleNode[] {
  const modules: ModuleNode[] = [];
  for (const [id, allGlobs] of server._importGlobMap!) {
    if (allGlobs.some((glob) => isMatch(file, glob)))
      modules.push(...(server.moduleGraph.getModulesByFile(id) || []));
  }
  modules.forEach((i) => {
    if (i?.file) server.moduleGraph.onFileChange(i.file);
  });
  return modules;
}
const { isMatch, scan: _scan } = micromatch;
