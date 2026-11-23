import * as vscode from "vscode";
import { AdonisRoutesDefinitionProvider } from "./services/adonisRoutesDefinitionProvider";
import { registerEdgePathNavigation } from "./services/edgePathNavigation";
import { registerEdgeSpacer } from "./services/edgeSpacer";
import { registerEdgeFormatter } from "./services/edgeFormatter";
import { registerGenerateModule } from "./services/generateModule";
import { registerEdgeComponentSnippets } from "./services/edgeComponentSnippets";

export function activate(context: vscode.ExtensionContext) {
  const routesProvider = new AdonisRoutesDefinitionProvider();

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: "typescript", pattern: "**/routes/**/*.ts" },
      routesProvider,
    ),
    vscode.languages.registerDefinitionProvider(
      { language: "typescript", pattern: "**/routes/*.ts" },
      routesProvider,
    ),
    vscode.languages.registerDefinitionProvider(
      { language: "typescript", pattern: "**/start/routes.ts" },
      routesProvider,
    ),
  );

  registerEdgePathNavigation(context);
  registerEdgeSpacer(context);
  registerEdgeFormatter(context);
  registerEdgeComponentSnippets(context);
  registerGenerateModule(context);
}

export function deactivate() {}
