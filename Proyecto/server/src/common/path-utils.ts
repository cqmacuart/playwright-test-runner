import * as path from "path";

export function normalizeRelative(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function ensureInsideRoot(root: string, absolutePath: string): boolean {
  const relative = path.relative(root, absolutePath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
