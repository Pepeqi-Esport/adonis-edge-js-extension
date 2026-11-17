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

/**
 * Document links for Edge path helpers:
 * - publicAsset('assets/...') → public/assets/...
 * - @vite('resources/...') / @vite(['a', 'b']) → resources/... from project root
 */
export class EdgeDocumentLinkProvider implements vscode.DocumentLinkProvider {
  private static readonly PUBLIC_ASSET_PATTERN =
    /\bpublicAsset\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

  private static readonly VITE_CALL_PATTERN = /@vite\s*\(/g;

  provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DocumentLink[]> {
    const projectRoot = this.findProjectRoot(document.uri.fsPath);
    if (!projectRoot) {
      return [];
    }

    const text = document.getText();
    const matches: PathMatch[] = [
      ...this.findPublicAssetPaths(text),
      ...this.findVitePaths(text),
    ];

    const links: vscode.DocumentLink[] = [];
    for (const match of matches) {
      const start = document.positionAt(match.pathOffset);
      const end = document.positionAt(match.pathOffset + match.path.length);
      const targetPath = this.resolveFile(
        projectRoot,
        match.path,
        match.underPublic
      );
      if (!targetPath) {
        continue;
      }

      const link = new vscode.DocumentLink(
        new vscode.Range(start, end),
        vscode.Uri.file(targetPath)
      );
      link.tooltip = `Open ${path.relative(projectRoot, targetPath)}`;
      links.push(link);
    }

    return links;
  }

  private findPublicAssetPaths(text: string): PathMatch[] {
    const matches: PathMatch[] = [];
    const pattern = new RegExp(
      EdgeDocumentLinkProvider.PUBLIC_ASSET_PATTERN.source,
      EdgeDocumentLinkProvider.PUBLIC_ASSET_PATTERN.flags
    );

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const assetPath = match[2];
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
      EdgeDocumentLinkProvider.VITE_CALL_PATTERN.source,
      EdgeDocumentLinkProvider.VITE_CALL_PATTERN.flags
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
        // Skip empty strings
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

  private resolveFile(
    projectRoot: string,
    assetPath: string,
    underPublic: boolean
  ): string | null {
    const relative = assetPath.replace(/^\/+/, "");
    if (!relative) {
      return null;
    }

    // Offer the link even if the file is missing (user can create it)
    return underPublic
      ? path.join(projectRoot, "public", relative)
      : path.join(projectRoot, relative);
  }

  private findProjectRoot(filePath: string): string | null {
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
}
