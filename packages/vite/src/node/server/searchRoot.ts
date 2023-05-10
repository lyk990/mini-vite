import fs from "node:fs";
import { dirname, join } from "node:path";
import { isFileReadable } from '../utils'

const ROOT_FILES = [
  "pnpm-workspace.yaml",

  "lerna.json",
];

function hasPackageJSON(root: string) {
  const path = join(root, "package.json");
  return fs.existsSync(path);
}

export function searchForPackageRoot(current: string, root = current): string {
  if (hasPackageJSON(current)) return current;

  const dir = dirname(current);
  // reach the fs root
  if (!dir || dir === current) return root;

  return searchForPackageRoot(dir, root);
}

export function searchForWorkspaceRoot(
  current: string,
  root = searchForPackageRoot(current)
): string {
  if (hasRootFile(current)) return current;
  if (hasWorkspacePackageJSON(current)) return current;

  const dir = dirname(current);
  // reach the fs root
  if (!dir || dir === current) return root;

  return searchForWorkspaceRoot(dir, root);
}

function hasRootFile(root: string): boolean {
  return ROOT_FILES.some((file) => fs.existsSync(join(root, file)));
}

function hasWorkspacePackageJSON(root: string): boolean {
  const path = join(root, "package.json");
  if (!isFileReadable(path)) {
    return false;
  }
  const content = JSON.parse(fs.readFileSync(path, "utf-8")) || {};
  return !!content.workspaces;
}
