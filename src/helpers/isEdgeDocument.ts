import * as vscode from "vscode";

/** True when the document is a .edge file or the editor language mode is Edge. */
export function isEdgeDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") {
    return false;
  }
  return (
    document.languageId === "edge" ||
    document.fileName.toLowerCase().endsWith(".edge")
  );
}
