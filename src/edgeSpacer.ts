import * as vscode from "vscode";

const TAG_TRIPLE = 0;
const TAG_DOUBLE = 1;

/**
 * Auto-space Edge mustache tags while typing, with auto-close kept ON:
 *   {{}}     → {{ | }}
 *   {{{}}}   → {{{ | }}}
 *   {{ {} }} → {{{ | }}}  (3rd `{` + autoClosingPairs)
 */
export function registerEdgeSpacer(context: vscode.ExtensionContext): void {
  const triggers = ["{}", "{", "}"];
  let applying = false;

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (e) => {
      if (applying || !isEdgeDocument(e.document)) {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== e.document) {
        return;
      }

      for (const change of e.contentChanges.slice().reverse()) {
        if (!triggers.includes(change.text)) {
          continue;
        }

        const result = findTagToSpace(e.document, change);
        if (!result) {
          continue;
        }

        const range = new vscode.Range(
          new vscode.Position(result.line, result.start),
          new vscode.Position(result.line, result.end),
        );

        const snippet =
          result.type === TAG_TRIPLE
            ? new vscode.SnippetString("{{{ $1 }}}$0")
            : new vscode.SnippetString("{{ $1 }}$0");

        applying = true;
        try {
          await editor.insertSnippet(snippet, range);
        } finally {
          // Allow the snippet document-change to settle before listening again
          setTimeout(() => {
            applying = false;
          }, 50);
        }
        return;
      }
    }),
  );
}

interface TagMatch {
  line: number;
  start: number;
  end: number;
  type: number;
}

function findTagToSpace(
  document: vscode.TextDocument,
  change: vscode.TextDocumentContentChangeEvent,
): TagMatch | null {
  const lineIdx = change.range.start.line;
  const lineText = document.lineAt(lineIdx).text;
  const caret = change.range.start.character + change.text.length;

  // A) {{ {} }} from typing `{` inside `{{ }}` with auto-close
  const broken = matchNear(lineText, /\{\{\s*\{\s*\}\s*\}\}/g, caret);
  if (broken) {
    return toMatch(lineIdx, broken, TAG_TRIPLE);
  }

  // B) `{}` landed between `{{` and `}}`
  if (change.text === "{}") {
    const before = lineText.slice(0, change.range.start.character);
    const after = lineText.slice(
      change.range.start.character + change.text.length,
    );
    if (/\{\{\s*$/.test(before) && /^\s*\}\}/.test(after)) {
      const start = before.search(/\{\{\s*$/);
      const endExtra = after.match(/^\s*\}\}/)?.[0].length ?? 0;
      return {
        line: lineIdx,
        start,
        end: change.range.start.character + change.text.length + endExtra,
        type: TAG_TRIPLE,
      };
    }
  }

  // C) {{{}}} unspaced
  const triple = matchNear(lineText, /\{\{\{(?!\s)(.*?)\}\}\}/g, caret);
  if (triple) {
    return toMatch(lineIdx, triple, TAG_TRIPLE);
  }

  // D) {{{...}} (missing one close)
  const almostTriple = matchNear(
    lineText,
    /\{\{\{(?!\s)(.*?)\}\}(?!\})/g,
    caret,
  );
  if (almostTriple) {
    return toMatch(lineIdx, almostTriple, TAG_TRIPLE);
  }

  // E) {{}} unspaced double — skip if triple open is present near caret
  const around = lineText.slice(Math.max(0, caret - 4), caret + 4);
  if (around.includes("{{{")) {
    return null;
  }

  const double = matchNear(
    lineText,
    /(?<!\{)\{\{(?!\{)(?!\s)(.*?)\}\}(?!\})/g,
    caret,
  );
  if (double) {
    // Skip already-spaced {{ ... }}
    if (/^\{\{\s/.test(double[0])) {
      return null;
    }
    return toMatch(lineIdx, double, TAG_DOUBLE);
  }

  return null;
}

function toMatch(line: number, m: RegExpExecArray, type: number): TagMatch {
  return {
    line,
    start: m.index,
    end: m.index + m[0].length,
    type,
  };
}

function matchNear(
  lineText: string,
  pattern: RegExp,
  caret: number,
): RegExpExecArray | null {
  const re = new RegExp(pattern.source, pattern.flags);
  let best: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (caret >= start && caret <= end + 1) {
      return m;
    }
    if (!best && Math.abs(caret - end) <= 2) {
      best = m;
    }
  }
  return best;
}

function isEdgeDocument(document: vscode.TextDocument): boolean {
  if (document.languageId === "edge") {
    return true;
  }
  return document.fileName.toLowerCase().endsWith(".edge");
}
