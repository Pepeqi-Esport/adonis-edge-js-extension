import * as fs from "fs";
import * as path from "path";

const importsCache = new Map<string, Record<string, unknown>>();
const cacheTimestamps = new Map<string, number>();

/**
 * Read `package.json#imports` for a project root (cached by package.json mtime).
 */
export function getPackageImports(projectRoot: string): Record<string, unknown> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  try {
    const stat = fs.statSync(packageJsonPath);
    const cacheKey = packageJsonPath;

    if (cacheTimestamps.get(cacheKey) !== stat.mtime.getTime()) {
      const content = fs.readFileSync(packageJsonPath, "utf8");
      const packageJson = JSON.parse(content);
      importsCache.set(cacheKey, packageJson.imports || {});
      cacheTimestamps.set(cacheKey, stat.mtime.getTime());
    }

    return importsCache.get(cacheKey) || {};
  } catch {
    return {};
  }
}
