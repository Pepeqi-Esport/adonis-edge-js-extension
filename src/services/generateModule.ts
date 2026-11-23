import * as path from "node:path";
import * as vscode from "vscode";
import { studly } from "../helpers/stringHelpers";
import type { FolderPath } from "../interfaces/generateModule";
import {
  findAdonisRoots,
  generateFiles,
  parseFolderPath,
} from "./moduleGenerator";

const GENERATE_MODULE_COMMAND = "adonis-edge.generateModule";

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
