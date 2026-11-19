import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { camel, kebab, plural, snake, studly } from "./stringHelpers";

type StubKind = "api" | "dashboard";

interface FolderPath {
  /** Snake segments, e.g. ["dashboard", "product"] */
  segments: string[];
  /** Path form: dashboard/product */
  path: string;
  stubKind: StubKind;
}

interface StubFileDef {
  stubRelative: string;
  targetRelative: string;
}

interface GenerateResult {
  created: string[];
  skipped: string[];
  errors: string[];
}

const GENERATE_MODULE_COMMAND = "adonis-edge.generateModule";

function parseFolderPath(raw: string): FolderPath {
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

function buildReplacements(name: string, folder: FolderPath): Record<string, string> {
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

function filesForFolder(name: string, folder: FolderPath): StubFileDef[] {
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

function isAdonisRoot(root: string): boolean {
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

function findAdonisRoots(): string[] {
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

async function pickAdonisRoot(): Promise<string | undefined> {
  const roots = findAdonisRoots();

  if (roots.length === 0) {
    vscode.window.showErrorMessage(
      "No AdonisJS project found. Open a workspace that contains `ace.js` or `adonisrc.ts`.",
    );
    return undefined;
  }

  if (roots.length === 1) {
    return roots[0];
  }

  const picked = await vscode.window.showQuickPick(
    roots.map((root) => ({
      label: path.basename(root),
      description: root,
      root,
    })),
    { placeHolder: "Select AdonisJS project" },
  );

  return picked?.root;
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

function generateFiles(
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

async function promptModuleName(): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: "Module name (e.g. Product / ProductCategory)",
    placeHolder: "ProductCategory",
    validateInput: (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return "Module name is required";
      }
      if (!/^[A-Za-z][A-Za-z0-9_\-\s]*$/.test(trimmed)) {
        return "Use letters, numbers, spaces, underscores, or hyphens";
      }
      return undefined;
    },
  });

  return value ? studly(value.trim()) : undefined;
}

async function promptFolderPath(): Promise<FolderPath | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: 'Folder path (optional, nested with "/"). Leave empty for root. e.g. api or dashboard/product',
    placeHolder: "Leave empty, or e.g. dashboard/product",
    value: "",
    validateInput: (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return undefined;
      }
      if (!/^[A-Za-z][A-Za-z0-9_\-\s/\\]*$/.test(trimmed)) {
        return 'Use letters, numbers, spaces, underscores, hyphens, and "/" for nesting';
      }
      return undefined;
    },
  });

  // undefined = cancelled; "" = intentionally empty path
  if (value === undefined) {
    return undefined;
  }

  return parseFolderPath(value.trim());
}

async function promptForce(): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "No", description: "Skip existing files", force: false },
      { label: "Yes", description: "Overwrite existing files", force: true },
    ],
    { placeHolder: "Overwrite existing files?" },
  );

  return picked?.force;
}

export function registerGenerateModule(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(GENERATE_MODULE_COMMAND, async () => {
    const projectRoot = await pickAdonisRoot();
    if (!projectRoot) {
      return;
    }

    const name = await promptModuleName();
    if (!name) {
      return;
    }

    const folder = await promptFolderPath();
    if (!folder) {
      return;
    }

    const force = await promptForce();
    if (force === undefined) {
      return;
    }

    const extensionStubsRoot = context.asAbsolutePath("stubs");
    const result = generateFiles(projectRoot, extensionStubsRoot, name, folder, force);

    const channel = vscode.window.createOutputChannel("Adonis Edge Generate Module");
    const logBlock = (title: string, items: string[]) => {
      if (items.length === 0) {
        return;
      }
      channel.appendLine(title);
      for (const item of items) {
        channel.appendLine(`  - ${item}`);
      }
    };

    const folderLabel = folder.path || "(root)";

    channel.clear();
    channel.appendLine(`Generate Module: ${name} → ${folderLabel} (stub: ${folder.stubKind})`);
    logBlock("Created:", result.created);
    logBlock("Skipped:", result.skipped);
    logBlock("Errors:", result.errors);

    if (result.errors.length > 0) {
      channel.show(true);
      vscode.window.showErrorMessage(
        `Generate Module finished with ${result.errors.length} error(s). See output for details.`,
      );
    } else if (result.created.length > 0) {
      vscode.window.showInformationMessage(
        `Generated ${result.created.length} file(s) for ${name} in ${folderLabel}${
          result.skipped.length ? ` (${result.skipped.length} skipped)` : ""
        }.`,
      );
      const first = path.join(projectRoot, result.created[0]);
      const doc = await vscode.workspace.openTextDocument(first);
      await vscode.window.showTextDocument(doc);
    } else if (result.skipped.length > 0) {
      vscode.window.showWarningMessage(
        `All ${result.skipped.length} file(s) already exist. Run again and choose Yes to overwrite.`,
      );
    } else {
      vscode.window.showWarningMessage("No files were generated.");
    }
  });

  context.subscriptions.push(disposable);
}
