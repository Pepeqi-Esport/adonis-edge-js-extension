import * as vscode from "vscode";

export const DEFAULT_VIEW_DISKS: Record<string, string> = {
  default: "resources/views",
};

export function getViewDisks(): Record<string, string> {
  const configured = vscode.workspace
    .getConfiguration("edge")
    .get<Record<string, string>>("disks");
  if (configured && typeof configured === "object") {
    return { ...DEFAULT_VIEW_DISKS, ...configured };
  }
  return DEFAULT_VIEW_DISKS;
}
