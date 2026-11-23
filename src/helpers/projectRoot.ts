import * as fs from "fs";
import * as path from "path";

/** Walk up from `filePath` to the nearest directory containing package.json. */
export function findProjectRoot(filePath: string): string | null {
  let currentDir = path.dirname(filePath);
  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return null;
}

export function isAdonisRoot(root: string): boolean {
  const markers = ["ace", "ace.js", "ace.ts", "adonisrc.ts", "adonisrc.js"];
  if (markers.some((marker) => fs.existsSync(path.join(root, marker)))) {
    return true;
  }

  const packageJsonPath = path.join(root, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.["@adonisjs/core"] || pkg.devDependencies?.["@adonisjs/core"],
    );
  } catch {
    return false;
  }
}
