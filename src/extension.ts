import * as vscode from "vscode";
import { AdonisRoutesDefinitionProvider } from "./definitionProvider";
import { EdgeDocumentLinkProvider } from "./edgeDocumentLinkProvider";
import { registerEdgeSpacer } from "./edgeSpacer";
import { registerEdgeFormatter } from "./edgeFormatter";

export function activate(context: vscode.ExtensionContext) {
  const routesProvider = new AdonisRoutesDefinitionProvider();

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: "typescript", pattern: "**/routes/**/*.ts" },
      routesProvider
    ),
    vscode.languages.registerDefinitionProvider(
      { language: "typescript", pattern: "**/routes/*.ts" },
      routesProvider
    ),
    vscode.languages.registerDefinitionProvider(
      { language: "typescript", pattern: "**/start/routes.ts" },
      routesProvider
    )
  );

  const edgeLinkProvider = new EdgeDocumentLinkProvider();
  const edgeSelectors: vscode.DocumentSelector = [
    { language: "edge", scheme: "file" },
    { pattern: "**/*.edge", scheme: "file" },
  ];

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      edgeSelectors,
      edgeLinkProvider
    )
  );

  registerEdgeSpacer(context);
  registerEdgeFormatter(context);
}

export function deactivate() {}
