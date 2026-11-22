import * as fs from "fs";
import * as path from "path";
import { camel } from "./stringHelpers";

/**
 * Walk `dir` recursively and collect `.edge` files.
 */
export function walkEdgeFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkEdgeFiles(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".edge")) {
      out.push(full);
    }
  }
}

/**
 * Convert a file path under `.../components/` to an Edge short-tag name.
 * Mirrors edge-js Loader.#getDiskComponents:
 * `input.edge` → `input`
 * `input_password.edge` → `inputPassword`
 * `form/field.edge` → `form.field`
 * `checkout_form/input.edge` → `checkoutForm.input`
 * `modal/index.edge` → `modal`
 */
export function tagNameFromComponentPath(
  componentFile: string,
  componentsRoot: string,
): string | null {
  const rel = path.relative(componentsRoot, componentFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  const withoutExt = rel.replace(/\.edge$/i, "");
  const parts = withoutExt.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  // Edge: drop `index` only when it is not the first segment
  const filtered = parts.filter((segment, index) => {
    return index === 0 || segment.toLowerCase() !== "index";
  });
  if (filtered.length === 0) {
    return null;
  }

  return filtered.map((segment) => camel(segment)).join(".");
}

/**
 * Build tagName → absolute file path map for all disks (Edge-compatible).
 * Named disks register as `diskName.tag` (e.g. `uikit.input`).
 */
export function buildComponentTagMap(
  projectRoot: string,
  disks: Record<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const [diskName, diskRoot] of Object.entries(disks)) {
    const componentsRoot = path.join(projectRoot, diskRoot, "components");
    const files: string[] = [];
    walkEdgeFiles(componentsRoot, files);

    for (const filePath of files) {
      const tagName = tagNameFromComponentPath(filePath, componentsRoot);
      if (!tagName) {
        continue;
      }

      const fullTag =
        diskName !== "default" ? `${diskName}.${tagName}` : tagName;

      if (!map.has(fullTag)) {
        map.set(fullTag, filePath);
      }

      // Also allow resolving named-disk components without the disk prefix
      // when the tag is unique (e.g. `@!input` still works if only uikit has it).
      if (diskName !== "default" && !map.has(tagName)) {
        map.set(tagName, filePath);
      }
    }
  }

  return map;
}
