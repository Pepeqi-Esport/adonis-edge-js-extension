import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { snake } from "./stringHelpers";

type PathKind = "public" | "project" | "view";

interface PathMatch {
  path: string;
  /** Absolute offset of the first character of the path (inside quotes) */
  pathOffset: number;
  kind: PathKind;
}

interface AbsoluteUrlMatch {
  url: string;
  /** Absolute offset of the first character of the URL (inside quotes) */
  urlOffset: number;
}

/** `@!input` / `@!form.field` short-tag → components/*.edge */
interface ComponentTagMatch {
  /** Tag name without @!, e.g. `input` or `form.field` */
  tagName: string;
  /** Absolute offset of the tag name (after `@` / `@!`) */
  tagOffset: number;
  tagLength: number;
  /** Absolute filesystem path to the .edge component */
  filePath: string;
}

const OPEN_EXTERNAL_URL_COMMAND = "edge.openExternalUrl";
const DEFAULT_VIEW_DISKS: Record<string, string> = {
  default: "resources/views",
};

/**
 * Built-in Edge tags that are not custom component short tags.
 * Keep in sync with formatter exclusions.
 */
const BUILTIN_EDGE_TAGS = new Set([
  "component",
  "slot",
  "if",
  "each",
  "unless",
  "forelse",
  "section",
  "stack",
  "push",
  "prepend",
  "else",
  "elseif",
  "end",
  "endsection",
  "endstack",
  "endpush",
  "endprepend",
  "include",
  "set",
  "inject",
  "break",
  "continue",
  "vite",
  "debug",
  "eval",
  "debugger",
  "let",
  "assign",
  "svg",
]);

/** `@!input` / `@input` / `@!form.field` / `@!uikit.input` */
const CUSTOM_COMPONENT_TAG_PATTERN = /@(!?)([a-zA-Z][\w.]*)\b/g;

/**
 * Path helpers and absolute http(s) URL navigation for Edge templates.
 *
 * editor.links is disabled for [edge] so built-in relative href/src
 * underlines (including src="{{ ... }}") are suppressed. Instead:
 * - Decorations: always-visible underline for publicAsset / @vite / @include /
 *   @component / custom short tags (@!input) / absolute http(s)
 * - DefinitionProvider: Ctrl/Cmd+Click + F12 for local files
 * - HoverProvider: absolute http(s) to Open URL command
 */
export class EdgePathNavigator {
  /** publicAsset( — args collected like @vite for nested/quoted paths */
  private static readonly PUBLIC_HELPER_CALL_PATTERN = /\bpublicAsset\s*\(/g;

  private static readonly VITE_CALL_PATTERN = /@vite\s*\(/g;

  /** @include('...') / @component('...') / @!component('...') */
  private static readonly VIEW_DIRECTIVE_PATTERN =
    /@!?component\s*\(|@include\s*\(/g;

  /** href / src / action / formaction / poster / data-src / data-href */
  private static readonly HTML_URL_ATTR_PATTERN =
    /\b(?:href|src|action|formaction|poster|data-src|data-href)\s*=\s*(['"])([^'"]*)\1/gi;

  private static readonly ABSOLUTE_URL_PATTERN = /^https?:\/\//i;

  findHelperPaths(text: string): PathMatch[] {
    return [
      ...this.findPublicHelperPaths(text),
      ...this.findVitePaths(text),
      ...this.findViewDirectivePaths(text),
    ];
  }

  /**
   * Custom component short tags: `@!input`, `@!form.field`, `@!uikit.input`.
   * Only returns tags that resolve to an existing file under components/.
   */
  findCustomComponentTags(
    text: string,
    projectRoot: string,
  ): ComponentTagMatch[] {
    const matches: ComponentTagMatch[] = [];
    const pattern = new RegExp(
      CUSTOM_COMPONENT_TAG_PATTERN.source,
      CUSTOM_COMPONENT_TAG_PATTERN.flags,
    );

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const bang = match[1];
      const tagName = match[2];
      const base = tagName.split(".")[0].toLowerCase();

      if (BUILTIN_EDGE_TAGS.has(base)) {
        continue;
      }

      const filePath = this.resolveComponentTagFile(projectRoot, tagName);
      if (!filePath) {
        continue;
      }

      // Underline the tag name only (`input` in `@!input`), not `@!`
      const tagOffset = match.index + 1 + bang.length;
      matches.push({
        tagName,
        tagOffset,
        tagLength: tagName.length,
        filePath,
      });
    }

    return matches;
  }

  /**
   * Edge tag → file (snake_case + optional index), matching Edge docs:
   * `input` → `{disk}/components/input.edge`
   * `inputGroup` → `{disk}/components/input_group.edge`
   * `form.field` → `{disk}/components/form/field.edge`
   * `checkoutForm.input` → `{disk}/components/checkout_form/input.edge`
   * `modal` → `{disk}/components/modal/index.edge` (fallback)
   * `uikit.input` → disk `uikit` + `components/input.edge` when that disk exists
   */
  resolveComponentTagFile(
    projectRoot: string,
    tagName: string,
  ): string | null {
    const trimmed = tagName.trim();
    if (!trimmed) {
      return null;
    }

    const disks = this.getViewDisks();
    const parts = trimmed.split(".").filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    const candidates: string[] = [];

    // Named disk: @!uikit.inputGroup → disk "uikit" / components/input_group.edge
    if (parts.length >= 2) {
      const diskName = parts[0];
      const diskRoot = disks[diskName];
      if (diskRoot && diskName !== "default") {
        this.pushComponentPathCandidates(
          candidates,
          projectRoot,
          diskRoot,
          parts.slice(1),
        );
      }
    }

    // Default / all disks: dots → path segments under components/
    for (const diskRoot of Object.values(disks)) {
      this.pushComponentPathCandidates(
        candidates,
        projectRoot,
        diskRoot,
        parts,
      );
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Build candidate paths for a component tag's path segments.
   * Tries Edge snake_case (`inputGroup` → `input_group.edge`) first, then
   * the literal segment names, plus `/index.edge` for folder components.
   */
  private pushComponentPathCandidates(
    candidates: string[],
    projectRoot: string,
    diskRoot: string,
    parts: string[],
  ): void {
    const variants: string[][] = [parts.map((part) => snake(part))];
    const literalSame = parts.every((part, i) => part === variants[0][i]);
    if (!literalSame) {
      variants.push(parts);
    }

    for (const fileParts of variants) {
      const base = path.join(
        projectRoot,
        diskRoot,
        "components",
        ...fileParts,
      );
      candidates.push(`${base}.edge`);
      candidates.push(path.join(base, "index.edge"));
    }
  }

  findAbsoluteHtmlUrls(text: string): AbsoluteUrlMatch[] {
    const matches: AbsoluteUrlMatch[] = [];
    const pattern = new RegExp(
      EdgePathNavigator.HTML_URL_ATTR_PATTERN.source,
      EdgePathNavigator.HTML_URL_ATTR_PATTERN.flags,
    );

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[2];
      // Skip Edge expressions / non-http values (e.g. src="{{ auth.user.profileFileUrl }}")
      if (
        url.includes("{{") ||
        !EdgePathNavigator.ABSOLUTE_URL_PATTERN.test(url)
      ) {
        continue;
      }
      const quote = match[1];
      const urlOffset =
        match.index + match[0].indexOf(quote + url + quote) + 1;
      matches.push({ url, urlOffset });
    }

    return matches;
  }

  resolveFile(
    projectRoot: string,
    assetPath: string,
    kind: PathKind,
  ): string | null {
    if (kind === "view") {
      return this.resolveViewFile(projectRoot, assetPath);
    }

    const relative = assetPath.replace(/^\/+/, "");
    if (!relative) {
      return null;
    }

    return kind === "public"
      ? path.join(projectRoot, "public", relative)
      : path.join(projectRoot, relative);
  }

  findProjectRoot(filePath: string): string | null {
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

  private getViewDisks(): Record<string, string> {
    const configured = vscode.workspace
      .getConfiguration("edge")
      .get<Record<string, string>>("disks");
    if (configured && typeof configured === "object") {
      return { ...DEFAULT_VIEW_DISKS, ...configured };
    }
    return DEFAULT_VIEW_DISKS;
  }

  /**
   * `dashboard/partials/sidebar` → resources/views/dashboard/partials/sidebar.edge
   * `docs::guide/intro` → disk "docs" path + guide/intro.edge
   */
  private resolveViewFile(
    projectRoot: string,
    templatePath: string,
  ): string | null {
    const trimmed = templatePath.trim();
    if (!trimmed) {
      return null;
    }

    const disks = this.getViewDisks();
    let diskName = "default";
    let viewPath = trimmed;

    const diskSep = trimmed.indexOf("::");
    if (diskSep !== -1) {
      diskName = trimmed.slice(0, diskSep) || "default";
      viewPath = trimmed.slice(diskSep + 2);
    }

    const diskRoot = disks[diskName] ?? disks.default;
    if (!diskRoot || !viewPath) {
      return null;
    }

    const withExt = viewPath.toLowerCase().endsWith(".edge")
      ? viewPath
      : `${viewPath}.edge`;

    return path.join(projectRoot, diskRoot, withExt.replace(/^\/+/, ""));
  }

  /**
   * Paths inside publicAsset(...) — same extraction style as @vite so
   * Ctrl/Cmd+hover works consistently inside `{{ publicAsset('…') }}`.
   */
  private findPublicHelperPaths(text: string): PathMatch[] {
    const matches: PathMatch[] = [];
    const callPattern = new RegExp(
      EdgePathNavigator.PUBLIC_HELPER_CALL_PATTERN.source,
      EdgePathNavigator.PUBLIC_HELPER_CALL_PATTERN.flags,
    );

    let call: RegExpExecArray | null;
    while ((call = callPattern.exec(text)) !== null) {
      const argsStart = call.index + call[0].length;
      const argsEnd = this.findMatchingParen(text, argsStart - 1);
      if (argsEnd === -1) {
        continue;
      }

      const args = text.slice(argsStart, argsEnd);
      const stringPattern = /(['"])([^'"]+)\1/g;
      let strMatch: RegExpExecArray | null;
      while ((strMatch = stringPattern.exec(args)) !== null) {
        const assetPath = strMatch[2];
        if (!assetPath.trim()) {
          continue;
        }
        matches.push({
          path: assetPath,
          pathOffset: argsStart + strMatch.index + 1,
          kind: "public",
        });
        // publicAsset takes a single path argument
        break;
      }
    }

    return matches;
  }

  /**
   * Collects every quoted path inside @vite(...) — supports a single string
   * or an array of strings.
   */
  private findVitePaths(text: string): PathMatch[] {
    const matches: PathMatch[] = [];
    const callPattern = new RegExp(
      EdgePathNavigator.VITE_CALL_PATTERN.source,
      EdgePathNavigator.VITE_CALL_PATTERN.flags,
    );

    let call: RegExpExecArray | null;
    while ((call = callPattern.exec(text)) !== null) {
      const argsStart = call.index + call[0].length;
      const argsEnd = this.findMatchingParen(text, argsStart - 1);
      if (argsEnd === -1) {
        continue;
      }

      const args = text.slice(argsStart, argsEnd);
      const stringPattern = /(['"])([^'"]+)\1/g;
      let strMatch: RegExpExecArray | null;
      while ((strMatch = stringPattern.exec(args)) !== null) {
        const vitePath = strMatch[2];
        if (!vitePath.trim()) {
          continue;
        }
        matches.push({
          path: vitePath,
          pathOffset: argsStart + strMatch.index + 1,
          kind: "project",
        });
      }
    }

    return matches;
  }

  /**
   * First quoted template path inside @include(...) / @component(...) /
   * @!component(...).
   */
  private findViewDirectivePaths(text: string): PathMatch[] {
    const matches: PathMatch[] = [];
    const callPattern = new RegExp(
      EdgePathNavigator.VIEW_DIRECTIVE_PATTERN.source,
      EdgePathNavigator.VIEW_DIRECTIVE_PATTERN.flags,
    );

    let call: RegExpExecArray | null;
    while ((call = callPattern.exec(text)) !== null) {
      const argsStart = call.index + call[0].length;
      const argsEnd = this.findMatchingParen(text, argsStart - 1);
      if (argsEnd === -1) {
        continue;
      }

      const args = text.slice(argsStart, argsEnd);
      const firstString = /^\s*(['"])([^'"]+)\1/.exec(args);
      if (!firstString) {
        continue;
      }

      const viewPath = firstString[2];
      if (!viewPath.trim()) {
        continue;
      }

      matches.push({
        path: viewPath,
        pathOffset: argsStart + firstString.index + firstString[0].indexOf(viewPath),
        kind: "view",
      });
    }

    return matches;
  }

  /** Index of `(` is openIdx; returns index of matching `)` or -1. */
  private findMatchingParen(text: string, openIdx: number): number {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;

    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (inSingle || inDouble) {
        continue;
      }
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }

    return -1;
  }
}

/** True when the document is a .edge file or the editor language mode is Edge. */
function isEdgeFile(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") {
    return false;
  }
  return (
    document.languageId === "edge" ||
    document.fileName.toLowerCase().endsWith(".edge")
  );
}

/**
 * Collect local file targets for helper paths + custom component tags.
 * Only includes targets whose file exists on disk.
 */
function collectLocalFileLinks(
  navigator: EdgePathNavigator,
  document: vscode.TextDocument,
): { range: vscode.Range; target: vscode.Uri }[] {
  if (!isEdgeFile(document)) {
    return [];
  }

  const projectRoot = navigator.findProjectRoot(document.uri.fsPath);
  if (!projectRoot) {
    return [];
  }

  const text = document.getText();
  const links: { range: vscode.Range; target: vscode.Uri }[] = [];

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

  return links;
}

/**
 * Ctrl/Cmd+Click + F12 for publicAsset / @vite / @include / @component / @!input.
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
      return [
        {
          targetUri: link.target,
          targetRange: new vscode.Range(0, 0, 0, 0),
          targetSelectionRange: new vscode.Range(0, 0, 0, 0),
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
    if (!isEdgeFile(document)) {
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
 * custom short tags (@!input) / absolute http(s) only.
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
    return isEdgeFile(document);
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
