import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  tagNameFromComponentPath,
  walkEdgeFiles,
} from "../helpers/edgeComponentDiscovery";
import { inferComponentProps } from "../helpers/inferComponentProps";
import { findProjectRoot } from "../helpers/projectRoot";
import { getViewDisks } from "../helpers/viewDisks";
import type { EdgeComponentInfo } from "../interfaces/edgeComponent";

function discoverComponents(projectRoot: string): EdgeComponentInfo[] {
  const disks = getViewDisks();
  const results: EdgeComponentInfo[] = [];
  const seenTags = new Set<string>();

  for (const diskRoot of Object.values(disks)) {
    const componentsRoot = path.join(projectRoot, diskRoot, "components");
    const files: string[] = [];
    walkEdgeFiles(componentsRoot, files);

    for (const filePath of files) {
      const tagName = tagNameFromComponentPath(filePath, componentsRoot);
      if (!tagName || seenTags.has(tagName)) {
        continue;
      }
      let source = "";
      try {
        source = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      seenTags.add(tagName);
      results.push({
        tagName,
        filePath,
        props: inferComponentProps(source),
      });
    }
  }

  return results.sort((a, b) => a.tagName.localeCompare(b.tagName));
}

function buildSnippetBody(tagName: string, props: string[]): string {
  if (props.length === 0) {
    return `@!${tagName}($0)`;
  }
  const lines = [`@!${tagName}({`];
  props.forEach((prop, idx) => {
    const comma = idx < props.length - 1 ? "," : "";
    lines.push(`\t${prop}: '\${${idx + 1}}'${comma}`);
  });
  lines.push("})$0");
  return lines.join("\n");
}

class EdgeComponentCompletionProvider
  implements vscode.CompletionItemProvider
{
  private cache = new Map<string, EdgeComponentInfo[]>();

  invalidate(): void {
    this.cache.clear();
  }

  private getComponents(document: vscode.TextDocument): EdgeComponentInfo[] {
    let projectRoot =
      document.uri.scheme === "file"
        ? findProjectRoot(document.uri.fsPath)
        : null;
    if (!projectRoot) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      projectRoot = folder?.uri.fsPath ?? null;
    }
    if (!projectRoot) {
      return [];
    }

    const cached = this.cache.get(projectRoot);
    if (cached) {
      return cached;
    }

    const components = discoverComponents(projectRoot);
    this.cache.set(projectRoot, components);
    return components;
  }

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position).text;
    const before = line.slice(0, position.character);
    // Trigger when typing @, @!, or a component-ish token
    if (!/@!?[\w.]*$/.test(before) && !/[\w.]$/.test(before)) {
      return [];
    }

    const components = this.getComponents(document);
    const items: vscode.CompletionItem[] = [];

    for (const component of components) {
      const snippet = buildSnippetBody(component.tagName, component.props);
      const label = `@!${component.tagName}`;

      const item = new vscode.CompletionItem(
        label,
        vscode.CompletionItemKind.Snippet,
      );
      item.insertText = new vscode.SnippetString(snippet);
      item.detail = `Edge component (${component.props.length} props)`;
      item.documentation = new vscode.MarkdownString(
        component.props.length > 0
          ? `Props: \`${component.props.join("`, `")}\`\n\nFrom \`${path.basename(component.filePath)}\``
          : `From \`${path.basename(component.filePath)}\``,
      );
      item.filterText = `${component.tagName} @!${component.tagName}`;
      item.sortText = `0_${component.tagName}`;
      items.push(item);

      // Also offer bare tag name without @! for easier filtering
      const bare = new vscode.CompletionItem(
        component.tagName,
        vscode.CompletionItemKind.Snippet,
      );
      bare.insertText = new vscode.SnippetString(snippet);
      bare.detail = item.detail;
      bare.documentation = item.documentation;
      bare.filterText = item.filterText;
      bare.sortText = `1_${component.tagName}`;
      items.push(bare);
    }

    return items;
  }
}

/**
 * Register dynamic snippets for custom Edge components under `components/`.
 */
export function registerEdgeComponentSnippets(
  context: vscode.ExtensionContext,
): void {
  const provider = new EdgeComponentCompletionProvider();

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [
        { language: "edge", scheme: "file" },
        { language: "edge", scheme: "untitled" },
        { pattern: "**/*.edge", scheme: "file" },
      ],
      provider,
      "@",
      "!",
      ".",
    ),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.fileName.toLowerCase().endsWith(".edge")) {
        provider.invalidate();
      }
    }),
    vscode.workspace.onDidCreateFiles(() => provider.invalidate()),
    vscode.workspace.onDidDeleteFiles(() => provider.invalidate()),
    vscode.workspace.onDidRenameFiles(() => provider.invalidate()),
  );
}
