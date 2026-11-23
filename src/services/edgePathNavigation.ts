import * as vscode from "vscode";
import * as fs from "fs";
import { findProjectRoot } from "../helpers/projectRoot";
import { isEdgeDocument } from "../helpers/isEdgeDocument";
import {
  findEdgeGlobalUsages,
  findMethodRangeInFile,
} from "./edgeGlobalDiscovery";
import { EdgePathNavigator } from "./edgePathNavigator";

const OPEN_EXTERNAL_URL_COMMAND = "edge.openExternalUrl";
interface LocalFileLink {
  range: vscode.Range;
  target: vscode.Uri;
  /** Prefer selecting this range in the target (e.g. method name) */
  targetSelectionRange?: vscode.Range;
}

/**
 * Collect local file targets for helper paths + custom component tags +
 * edge.global helpers. Only includes targets whose file exists on disk.
 */
function collectLocalFileLinks(
  navigator: EdgePathNavigator,
  document: vscode.TextDocument,
): LocalFileLink[] {
  if (!isEdgeDocument(document)) {
    return [];
  }

  const projectRoot = findProjectRoot(document.uri.fsPath);
  if (!projectRoot) {
    return [];
  }

  const text = document.getText();
  const links: LocalFileLink[] = [];

  for (const match of navigator.findHelperPaths(text)) {
    const targetPath = navigator.resolveFile(
      projectRoot,
      match.path,
      match.kind,
    );
    if (!targetPath || !fs.existsSync(targetPath)) {
      continue;
    }
    links.push({
      range: new vscode.Range(
        document.positionAt(match.pathOffset),
        document.positionAt(match.pathOffset + match.path.length),
      ),
      target: vscode.Uri.file(targetPath),
    });
  }

  for (const match of navigator.findCustomComponentTags(text, projectRoot)) {
    links.push({
      range: new vscode.Range(
        document.positionAt(match.tagOffset),
        document.positionAt(match.tagOffset + match.tagLength),
      ),
      target: vscode.Uri.file(match.filePath),
    });
  }

  const globals = navigator.getEdgeGlobals(projectRoot);
  for (const match of findEdgeGlobalUsages(text, globals)) {
    let targetSelectionRange: vscode.Range | undefined;
    if (match.methodName) {
      const methodRange = findMethodRangeInFile(
        match.filePath,
        match.methodName,
      );
      if (methodRange) {
        targetSelectionRange = new vscode.Range(
          methodRange.startLine,
          methodRange.startCharacter,
          methodRange.endLine,
          methodRange.endCharacter,
        );
      }
    }
    links.push({
      range: new vscode.Range(
        document.positionAt(match.offset),
        document.positionAt(match.offset + match.length),
      ),
      target: vscode.Uri.file(match.filePath),
      targetSelectionRange,
    });
  }

  return links;
}

/**
 * Ctrl/Cmd+Click + F12 for publicAsset / @vite / @include / @component /
 * @!input / edge.global helpers (FormatterHelper.formatNumber).
 *
 * Returns LocationLink with `originSelectionRange` so Ctrl/Cmd+hover shows the
 * pointer + underline on the full path (including inside `{{ publicAsset('…') }}`),
 * same UX as `@vite('…')` — without enabling editor.links.
 */
export class EdgePathDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly navigator: EdgePathNavigator) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LocationLink[]> {
    for (const link of collectLocalFileLinks(this.navigator, document)) {
      if (!rangeContainsPosition(link.range, position)) {
        continue;
      }
      const selection =
        link.targetSelectionRange ?? new vscode.Range(0, 0, 0, 0);
      return [
        {
          targetUri: link.target,
          targetRange: selection,
          targetSelectionRange: selection,
          originSelectionRange: link.range,
        },
      ];
    }
    return null;
  }
}

/** Inclusive end — `Range.contains` can miss the last column in some cases. */
function rangeContainsPosition(
  range: vscode.Range,
  position: vscode.Position,
): boolean {
  if (range.contains(position)) {
    return true;
  }
  return range.end.line === position.line && range.end.character === position.character;
}

/**
 * Hover on absolute http(s) values in HTML URL attributes with a command
 * link to open externally (editor.links is off for edge).
 */
export class EdgeAbsoluteUrlHoverProvider implements vscode.HoverProvider {
  constructor(private readonly navigator: EdgePathNavigator) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    if (!isEdgeDocument(document)) {
      return null;
    }

    const offset = document.offsetAt(position);
    const matches = this.navigator.findAbsoluteHtmlUrls(document.getText());

    for (const match of matches) {
      const start = match.urlOffset;
      const end = match.urlOffset + match.url.length;
      if (offset < start || offset > end) {
        continue;
      }

      const range = new vscode.Range(
        document.positionAt(start),
        document.positionAt(end),
      );
      const args = encodeURIComponent(JSON.stringify([match.url]));
      const md = new vscode.MarkdownString(
        `[Open URL](command:${OPEN_EXTERNAL_URL_COMMAND}?${args})`,
      );
      md.isTrusted = { enabledCommands: [OPEN_EXTERNAL_URL_COMMAND] };
      md.supportHtml = false;

      return new vscode.Hover(md, range);
    }

    return null;
  }
}

/**
 * Link-style underlines for publicAsset / @vite / @include / @component /
 * custom short tags (@!input) / edge.global helpers / absolute http(s).
 * Avoids re-enabling editor.links (relative HTML links).
 */
class EdgeLinkUnderlineDecorator {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly navigator: EdgePathNavigator) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      // Underline only — keep text color; offset adds a little gap below glyphs.
      // Semicolon hack: VS Code wraps this as `text-decoration: …`, so the
      // second declaration lands in the same CSS rule.
      textDecoration:
        "underline solid currentColor; text-underline-offset: 3px",
    });
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.decorationType,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.updateEditor(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.visibleTextEditors.find(
          (e) => e.document === event.document,
        );
        if (editor && this.isEdgeDocument(editor.document)) {
          this.scheduleUpdate(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.updateEditor(editor);
        }
      }),
    );

    for (const editor of vscode.window.visibleTextEditors) {
      this.updateEditor(editor);
    }
  }

  private isEdgeDocument(document: vscode.TextDocument): boolean {
    return isEdgeDocument(document);
  }

  private scheduleUpdate(editor: vscode.TextEditor): void {
    const key = editor.document.uri.toString();
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.updateEditor(editor);
      }, 150),
    );
  }

  private updateEditor(editor: vscode.TextEditor): void {
    if (!this.isEdgeDocument(editor.document)) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const document = editor.document;
    const text = document.getText();
    const ranges: vscode.Range[] = [];

    // Local files — only when the target exists on disk
    for (const link of collectLocalFileLinks(this.navigator, document)) {
      ranges.push(link.range);
    }

    // Absolute http(s) URLs
    for (const match of this.navigator.findAbsoluteHtmlUrls(text)) {
      ranges.push(
        new vscode.Range(
          document.positionAt(match.urlOffset),
          document.positionAt(match.urlOffset + match.url.length),
        ),
      );
    }

    editor.setDecorations(this.decorationType, ranges);
  }
}

export function registerEdgePathNavigation(
  context: vscode.ExtensionContext,
): void {
  const navigator = new EdgePathNavigator();
  // .edge files OR language mode "edge" (either condition is enough).
  const edgeSelectors: vscode.DocumentSelector = [
    { language: "edge", scheme: "file" },
    { language: "edge", scheme: "untitled" },
    { pattern: "**/*.edge", scheme: "file" },
  ];

  const underlineDecorator = new EdgeLinkUnderlineDecorator(navigator);
  underlineDecorator.register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      OPEN_EXTERNAL_URL_COMMAND,
      async (url?: string) => {
        if (typeof url !== "string" || !url.trim()) {
          return;
        }
        try {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch {
          vscode.window.showWarningMessage(`Failed to open URL: ${url}`);
        }
      },
    ),
    vscode.languages.registerDefinitionProvider(
      edgeSelectors,
      new EdgePathDefinitionProvider(navigator),
    ),
    vscode.languages.registerHoverProvider(
      edgeSelectors,
      new EdgeAbsoluteUrlHoverProvider(navigator),
    ),
  );
}
