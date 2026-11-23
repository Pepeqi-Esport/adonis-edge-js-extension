import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { camel, kebab, plural, snake } from "../helpers/stringHelpers";
import { isAdonisRoot } from "../helpers/projectRoot";
import type {
  FolderPath,
  GenerateResult,
  StubFileDef,
  StubKind,
} from "../interfaces/generateModule";

export function parseFolderPath(raw: string): FolderPath {
  const segments = raw
    .split(/[/\\]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => snake(part));

  const first = segments[0]?.toLowerCase();
  const stubKind: StubKind = first === "api" ? "api" : "dashboard";

  return {
    segments,
    path: segments.join("/"),
    stubKind,
  };
}

export function buildReplacements(name: string, folder: FolderPath): Record<string, string> {
  const snakeName = snake(name);
  const labelName = snakeName.replace(/_/g, " ").toLowerCase();
  const folderImport = folder.path ? `${folder.path}/` : "";

  return {
    "{{ name }}": name,
    "{{ camelName }}": camel(name),
    "{{ snakeName }}": snakeName,
    "{{ kebabName }}": kebab(name),
    "{{ tableName }}": plural(snakeName),
    "{{ labelName }}": labelName,
    "{{ folderPath }}": folder.path,
    "{{ folderImport }}": folderImport,
  };
}

export function filesForFolder(name: string, folder: FolderPath): StubFileDef[] {
  const snakeName = snake(name);
  const folderParts = folder.segments;
  const stubDir = folder.stubKind;

  return [
    {
      stubRelative: path.join("module", stubDir, "controller.stub"),
      targetRelative: path.join("app", "controllers", ...folderParts, `${snakeName}_controller.ts`),
    },
    {
      stubRelative: path.join("module", stubDir, "validation.stub"),
      targetRelative: path.join("app", "validations", ...folderParts, `${snakeName}_validation.ts`),
    },
    {
      stubRelative: path.join("module", stubDir, "service.stub"),
      targetRelative: path.join("app", "services", ...folderParts, `${snakeName}_service.ts`),
    },
  ];
}

export function findAdonisRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots: string[] = [];

  for (const folder of folders) {
    const root = folder.uri.fsPath;
    if (isAdonisRoot(root)) {
      roots.push(root);
    }
  }

  return roots;
}

function resolveStubPath(
  projectRoot: string,
  extensionStubsRoot: string,
  stubRelative: string,
): string | null {
  const projectStub = path.join(projectRoot, "stubs", stubRelative);
  if (fs.existsSync(projectStub)) {
    return projectStub;
  }

  const bundledStub = path.join(extensionStubsRoot, stubRelative);
  if (fs.existsSync(bundledStub)) {
    return bundledStub;
  }

  return null;
}

function applyReplacements(content: string, replacements: Record<string, string>): string {
  let result = content;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }
  return result;
}

export function generateFiles(
  projectRoot: string,
  extensionStubsRoot: string,
  name: string,
  folder: FolderPath,
  force: boolean,
): GenerateResult {
  const replacements = buildReplacements(name, folder);
  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const file of filesForFolder(name, folder)) {
    const targetPath = path.join(projectRoot, file.targetRelative);
    const relativeTarget = path.relative(projectRoot, targetPath).replace(/\\/g, "/");

    if (fs.existsSync(targetPath) && !force) {
      skipped.push(relativeTarget);
      continue;
    }

    const stubPath = resolveStubPath(projectRoot, extensionStubsRoot, file.stubRelative);
    if (!stubPath) {
      errors.push(`Stub not found: stubs/${file.stubRelative.replace(/\\/g, "/")}`);
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const content = applyReplacements(fs.readFileSync(stubPath, "utf8"), replacements);
      fs.writeFileSync(targetPath, content, "utf8");
      created.push(relativeTarget);
    } catch (err: any) {
      errors.push(`${relativeTarget}: ${err?.message ?? String(err)}`);
    }
  }

  return { created, skipped, errors };
}
