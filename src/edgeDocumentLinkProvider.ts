import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

interface PathMatch {
  path: string;
  /** Absolute offset of the first character of the path (inside quotes) */
  pathOffset: number;
  /** Resolve under public/ when true; otherwise from project root */
  underPublic: boolean;
}

interface AbsoluteUrlMatch {
  url: string;
  /** Absolute offset of the first character of the URL (inside quotes) */
  urlOffset: number;
}

const OPEN_EXTERNAL_URL_COMMAND = "edge.openExternalUrl";

/**
 * Path helpers and absolute http(s) URL navigation for Edge templates.
 *
 * editor.links is disabled for [edge] so HTML Language Service relative
 * href/src/action underlines are suppressed. Navigation is restored via:
 * - DefinitionProvider for publicAsset / @vite → local files
 * - HoverProvider for absolute http(s) HTML attribute URLs → open external
 */
export class EdgePathNavigator {
  private static readonly PUBLIC_HELPER_PATTERN =
    /\bpublicAsset\s*\(\s*(['"])([^'"]*)\1\s*\)/g;

  private static readonly VITE_CALL_PATTERN = /@vite\s*\(/g;

  /** href / src / action / formaction / poster / data-src / data-href */
  private static readonly HTML_URL_ATTR_PATTERN =
    /\b(?:href|src|action|formaction|poster|data-src|data-href)\s*=\s*(['"])([^'"]*)\1/gi;

  private static readonly ABSOLUTE_URL_PATTERN = /^https?:\/\//i;

  findHelperPaths(text: string): PathMatch[] {
    return [...this.findPublicHelperPaths(text), ...this.findVitePaths(text)];
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
      if (!EdgePathNavigator.ABSOLUTE_URL_PATTERN.test(url)) {
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
    underPublic: boolean,
  ): string | null {
    const relative = assetPath.replace(/^\/+/, "");
    if (!relative) {
      return null;
    }

    return underPublic
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

  private findPublicHelperPaths(text: string): PathMatch[] {
    const matches: PathMatch[] = [];
    const pattern = new RegExp(
      EdgePathNavigator.PUBLIC_HELPER_PATTERN.source,
      EdgePathNavigator.PUBLIC_HELPER_PATTERN.flags,
    );

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const assetPath = match[2];
      if (!assetPath.trim()) {
        continue;
      }
      const quote = match[1];
      const pathLiteralOffset =
        match.index + match[0].indexOf(quote + assetPath + quote) + 1;
      matches.push({
        path: assetPath,
        pathOffset: pathLiteralOffset,
        underPublic: true,
      });
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
          underPublic: false,
        });
      }
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

/** Ctrl/Cmd+Click publicAsset / @vite path strings → local files. */
export class EdgePathDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly navigator: EdgePathNavigator) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition> {
    const projectRoot = this.navigator.findProjectRoot(document.uri.fsPath);
    if (!projectRoot) {
      return null;
    }

    const offset = document.offsetAt(position);
    const matches = this.navigator.findHelperPaths(document.getText());

    for (const match of matches) {
      const start = match.pathOffset;
      const end = match.pathOffset + match.path.length;
      if (offset < start || offset > end) {
        continue;
      }

      const targetPath = this.navigator.resolveFile(
        projectRoot,
        match.path,
        match.underPublic,
      );
      if (!targetPath) {
        return null;
      }

      return new vscode.Location(
        vscode.Uri.file(targetPath),
        new vscode.Position(0, 0),
      );
    }

    return null;
  }
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

export function registerEdgePathNavigation(
  context: vscode.ExtensionContext,
): void {
  const navigator = new EdgePathNavigator();
  const edgeSelectors: vscode.DocumentSelector = [
    { language: "edge", scheme: "file" },
    { pattern: "**/*.edge", scheme: "file" },
  ];

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
