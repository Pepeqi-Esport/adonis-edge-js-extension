import * as vscode from "vscode";
import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";

export class AdonisRoutesDefinitionProvider
  implements vscode.DefinitionProvider
{
  private importsCache = new Map<string, Record<string, unknown>>();
  private cacheTimestamps = new Map<string, number>();

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition | vscode.DefinitionLink[]> {
    try {
      const filePath = document.fileName;
      if (!this.isSupportedFile(filePath)) {
        return null;
      }

      const projectRoot = this.findProjectRoot(filePath);
      if (!projectRoot) {
        return null;
      }

      const sourceFile = ts.createSourceFile(
        filePath,
        document.getText(),
        ts.ScriptTarget.Latest,
        true,
      );

      const offset = document.offsetAt(position);
      const node = this.findNodeAtPosition(sourceFile, offset);
      if (!node) {
        return null;
      }

      const clickContext = this.analyzeClickContext(node, offset);
      if (!clickContext) {
        return null;
      }

      const resolved = this.resolveDefinition(
        clickContext,
        projectRoot,
        sourceFile,
      );
      if (!resolved) {
        return null;
      }

      // Prefer our target over TypeScript's built-in jump to the local variable/import.
      if (
        clickContext.type === "controller_variable" ||
        clickContext.type === "controller_barrel" ||
        clickContext.type === "method_string" ||
        clickContext.type === "controller_import_path"
      ) {
        const originSelectionRange =
          clickContext.selectionStart !== undefined &&
          clickContext.selectionEnd !== undefined
            ? new vscode.Range(
                document.positionAt(clickContext.selectionStart),
                document.positionAt(clickContext.selectionEnd),
              )
            : this.getNodeRange(document, sourceFile, node);

        return [
          {
            originSelectionRange,
            targetUri: resolved.uri,
            targetRange: resolved.range,
            targetSelectionRange: resolved.range,
          },
        ];
      }

      return resolved;
    } catch (error) {
      console.error("AdonisJS Routes Goto Error:", error);
      return null;
    }
  }

  private getNodeRange(
    document: vscode.TextDocument,
    sourceFile: ts.SourceFile,
    node: ts.Node,
  ): vscode.Range {
    const start = document.positionAt(node.getStart(sourceFile));
    const end = document.positionAt(node.getEnd());
    return new vscode.Range(start, end);
  }

  private isSupportedFile(filePath: string): boolean {
    const normalizedPath = path.normalize(filePath);
    return (
      normalizedPath.includes(path.sep + "routes" + path.sep) ||
      normalizedPath.endsWith(path.sep + "routes.ts") ||
      normalizedPath.endsWith(path.sep + "start" + path.sep + "routes.ts")
    );
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

  private findNodeAtPosition(
    sourceFile: ts.SourceFile,
    position: number,
  ): ts.Node | null {
    function find(node: ts.Node): ts.Node | null {
      if (position >= node.getStart() && position <= node.getEnd()) {
        for (const child of node.getChildren()) {
          const found = find(child);
          if (found) {
            return found;
          }
        }
        return node;
      }
      return null;
    }
    return find(sourceFile);
  }

  private analyzeClickContext(
    node: ts.Node,
    offset: number,
  ): ClickContext | null {
    if (ts.isIdentifier(node)) {
      return this.analyzeIdentifierClick(node);
    }

    if (ts.isStringLiteral(node)) {
      return this.analyzeStringLiteralClick(node, offset);
    }

    return null;
  }

  private analyzeIdentifierClick(node: ts.Identifier): ClickContext | null {
    // Click on property in controllers.Posts or controllers.auth.Login
    const barrelPath = this.getBarrelPathFromIdentifier(node);
    if (barrelPath && this.isControllerRefInRouterHandler(node)) {
      return {
        type: "controller_barrel",
        barrelPath,
      };
    }

    // Click on first element of [AuthController, 'method']
    if (
      ts.isArrayLiteralExpression(node.parent) &&
      node.parent.elements.length === 2 &&
      node.parent.elements[0] === node &&
      ts.isStringLiteral(node.parent.elements[1]) &&
      this.findRouterCall(node)
    ) {
      return {
        type: "controller_variable",
        variableName: node.text,
      };
    }

    const routerCall = this.findRouterCall(node);
    if (routerCall) {
      const handler = this.extractHandlerFromRouterCall(routerCall);
      if (handler?.type === "controller_variable" && handler.variableName) {
        return {
          type: "controller_variable",
          variableName: handler.variableName,
          methodName: handler.methodName,
        };
      }
    }

    const routesGroup = this.findRoutesGroupCall(node);
    if (routesGroup) {
      return {
        type: "routes_module",
        moduleName: node.text,
      };
    }

    return null;
  }

  private analyzeStringLiteralClick(
    node: ts.StringLiteral,
    offset: number,
  ): ClickContext | null {
    const tupleContext = this.isMethodStringInTuple(node);
    if (tupleContext) {
      if (tupleContext.barrelPath) {
        return {
          type: "method_string",
          barrelPath: tupleContext.barrelPath,
          methodName: node.text,
        };
      }

      return {
        type: "method_string",
        controllerName: tupleContext.controllerName,
        methodName: node.text,
      };
    }

    // Magic string: '#controllers/foo/bar_controller.index'
    const magic = this.parseMagicControllerString(node.text);
    if (magic) {
      const contentStart = node.getStart() + 1; // skip opening quote
      const methodDotOffset = contentStart + magic.importPath.length;
      const methodStart = methodDotOffset + 1; // skip '.'
      const methodEnd = methodStart + magic.methodName.length;
      const clickedMethod = offset >= methodStart && offset <= methodEnd;

      if (clickedMethod) {
        return {
          type: "method_string",
          importPath: magic.importPath,
          methodName: magic.methodName,
          selectionStart: methodStart,
          selectionEnd: methodEnd,
        };
      }

      return {
        type: "controller_import_path",
        importPath: magic.importPath,
        selectionStart: contentStart,
        selectionEnd: methodDotOffset,
      };
    }

    if (node.text.startsWith("#controllers/")) {
      return {
        type: "controller_import_path",
        importPath: node.text,
      };
    }

    return null;
  }

  /**
   * Parse Adonis magic string '#controllers/path/to_controller.method'
   */
  private parseMagicControllerString(
    text: string,
  ): { importPath: string; methodName: string } | null {
    if (!text.startsWith("#controllers/")) {
      return null;
    }

    const lastDot = text.lastIndexOf(".");
    if (lastDot <= "#controllers/".length) {
      return null;
    }

    const importPath = text.slice(0, lastDot);
    const methodName = text.slice(lastDot + 1);

    // Method must be a simple identifier; path must not look like a file extension only.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(methodName)) {
      return null;
    }

    // Avoid treating '#controllers/foo.ts' style as magic (no real case, but be safe)
    if (importPath.endsWith("/") || !importPath.includes("/")) {
      return null;
    }

    return { importPath, methodName };
  }

  /**
   * If identifier is the rightmost name in controllers.X(.Y)*, return path
   * segments after `controllers` (e.g. ["Posts"] or ["auth","Login"]).
   */
  private getBarrelPathFromIdentifier(node: ts.Identifier): string[] | null {
    // Must be the property name: controllers.Posts → clicking "Posts"
    if (
      !ts.isPropertyAccessExpression(node.parent) ||
      node.parent.name !== node
    ) {
      return null;
    }

    const segments: string[] = [];
    let current: ts.Expression = node.parent;

    while (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
      current = current.expression;
    }

    if (!ts.isIdentifier(current) || current.text !== "controllers") {
      return null;
    }

    return segments.length > 0 ? segments : null;
  }

  private isControllerRefInRouterHandler(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;
    while (current) {
      if (
        ts.isArrayLiteralExpression(current) &&
        current.elements.length === 2 &&
        ts.isStringLiteral(current.elements[1])
      ) {
        return this.findRouterCall(current) !== null;
      }
      current = current.parent;
    }
    return false;
  }

  private findRouterCall(node: ts.Node): ts.CallExpression | null {
    let current: ts.Node | undefined = node;
    while (current) {
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression)
      ) {
        const methodName = current.expression.name.text;
        if (
          [
            "get",
            "post",
            "put",
            "patch",
            "delete",
            "any",
            "route",
            "resource",
            "group",
          ].includes(methodName)
        ) {
          return current;
        }
      }
      current = current.parent;
    }
    return null;
  }

  private extractHandlerFromRouterCall(
    call: ts.CallExpression,
  ): HandlerInfo | null {
    if (call.arguments.length >= 2) {
      return this.parseHandlerArgument(call.arguments[1]);
    }

    let currentCall = call;
    while (currentCall.parent && ts.isCallExpression(currentCall.parent)) {
      currentCall = currentCall.parent;
      if (currentCall.arguments.length >= 2) {
        return this.parseHandlerArgument(currentCall.arguments[1]);
      }
    }

    return null;
  }

  private parseHandlerArgument(arg: ts.Expression): HandlerInfo | null {
    if (ts.isArrayLiteralExpression(arg) && arg.elements.length === 2) {
      const controllerExpr = arg.elements[0];
      const methodExpr = arg.elements[1];

      if (!ts.isStringLiteral(methodExpr)) {
        return null;
      }

      const barrelPath = this.getBarrelPathFromExpression(controllerExpr);
      if (barrelPath) {
        return {
          type: "controller_barrel",
          barrelPath,
          methodName: methodExpr.text,
        };
      }

      if (ts.isIdentifier(controllerExpr)) {
        return {
          type: "controller",
          controllerName: controllerExpr.text,
          methodName: methodExpr.text,
        };
      }
    }

    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      return null;
    }

    if (ts.isIdentifier(arg)) {
      return {
        type: "controller_variable",
        variableName: arg.text,
      };
    }

    return null;
  }

  private getBarrelPathFromExpression(expr: ts.Expression): string[] | null {
    if (!ts.isPropertyAccessExpression(expr)) {
      return null;
    }

    const segments: string[] = [];
    let current: ts.Expression = expr;

    while (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
      current = current.expression;
    }

    if (!ts.isIdentifier(current) || current.text !== "controllers") {
      return null;
    }

    return segments.length > 0 ? segments : null;
  }

  private isMethodStringInTuple(node: ts.StringLiteral): {
    controllerName?: string;
    barrelPath?: string[];
  } | null {
    let current: ts.Node = node;
    while (current) {
      if (
        ts.isArrayLiteralExpression(current) &&
        current.elements.length === 2
      ) {
        const index = current.elements.indexOf(node as ts.Expression);
        if (index === 1) {
          const controllerExpr = current.elements[0];
          const barrelPath = this.getBarrelPathFromExpression(controllerExpr);
          if (barrelPath) {
            return { barrelPath };
          }
          if (ts.isIdentifier(controllerExpr)) {
            return { controllerName: controllerExpr.text };
          }
        }
      }
      current = current.parent;
    }
    return null;
  }

  private findRoutesGroupCall(node: ts.Node): ts.CallExpression | null {
    let current: ts.Node | undefined = node;
    while (current) {
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === "group"
      ) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  private resolveDefinition(
    context: ClickContext,
    projectRoot: string,
    sourceFile: ts.SourceFile,
  ): vscode.Location | null {
    switch (context.type) {
      case "controller_variable":
        if (!context.variableName) {
          return null;
        }
        return this.resolveControllerVariableDefinition(
          context.variableName,
          context.methodName,
          projectRoot,
          sourceFile,
        );

      case "controller_barrel":
        if (!context.barrelPath?.length) {
          return null;
        }
        return this.resolveFromControllersBarrel(
          projectRoot,
          context.barrelPath,
          context.methodName,
        );

      case "method_string":
        if (context.barrelPath?.length) {
          return this.resolveFromControllersBarrel(
            projectRoot,
            context.barrelPath,
            context.methodName,
          );
        }
        if (context.importPath) {
          return this.resolveImportPathWithOptionalMethod(
            context.importPath,
            context.methodName,
            projectRoot,
          );
        }
        if (!context.controllerName) {
          return null;
        }
        return this.resolveControllerDefinition(
          context.controllerName,
          context.methodName,
          projectRoot,
          sourceFile,
        );

      case "controller_import_path":
        if (!context.importPath) {
          return null;
        }
        return this.resolveImportPathWithOptionalMethod(
          context.importPath,
          undefined,
          projectRoot,
        );

      case "routes_module":
        if (!context.moduleName) {
          return null;
        }
        return this.resolveRoutesModule(
          context.moduleName,
          projectRoot,
          sourceFile,
        );

      default:
        return null;
    }
  }

  private resolveImportPathWithOptionalMethod(
    importPath: string,
    methodName: string | undefined,
    projectRoot: string,
  ): vscode.Location | null {
    const location = this.resolveControllerFromImportPath(
      importPath,
      projectRoot,
    );
    if (!location) {
      return null;
    }

    if (!methodName) {
      return location;
    }

    return (
      this.findMethodInControllerFile(location.uri.fsPath, methodName) ||
      location
    );
  }

  private resolveControllerVariableDefinition(
    variableName: string,
    methodName: string | undefined,
    projectRoot: string,
    sourceFile: ts.SourceFile,
  ): vscode.Location | null {
    const importPath = this.findControllerImportPath(variableName, sourceFile);
    if (!importPath) {
      return null;
    }

    const location = this.resolveControllerFromImportPath(
      importPath,
      projectRoot,
    );
    if (!location) {
      return null;
    }

    if (!methodName) {
      return location;
    }

    return (
      this.findMethodInControllerFile(location.uri.fsPath, methodName) ||
      location
    );
  }

  private resolveControllerDefinition(
    controllerName: string,
    methodName: string | undefined,
    projectRoot: string,
    sourceFile?: ts.SourceFile,
  ): vscode.Location | null {
    if (sourceFile) {
      const importPath = this.findControllerImportPath(
        controllerName,
        sourceFile,
      );
      if (importPath) {
        const location = this.resolveControllerFromImportPath(
          importPath,
          projectRoot,
        );
        if (location) {
          if (!methodName) {
            return location;
          }
          return (
            this.findMethodInControllerFile(location.uri.fsPath, methodName) ||
            location
          );
        }
      }
    }

    const controllerPath = this.resolveControllerPath(
      controllerName,
      projectRoot,
    );
    if (!controllerPath) {
      return null;
    }

    const controllerUri = vscode.Uri.file(controllerPath);
    if (!methodName) {
      return new vscode.Location(controllerUri, new vscode.Position(0, 0));
    }

    return (
      this.findMethodInControllerFile(controllerPath, methodName) ||
      new vscode.Location(controllerUri, new vscode.Position(0, 0))
    );
  }

  /**
   * Resolve [controllers.Posts, 'index'] via .adonisjs/server/controllers.ts barrel.
   */
  private resolveFromControllersBarrel(
    projectRoot: string,
    pathSegments: string[],
    methodName?: string,
  ): vscode.Location | null {
    const importPath =
      this.lookupBarrelImportPath(projectRoot, pathSegments) ||
      this.fallbackControllerImportFromSegments(pathSegments);

    if (!importPath) {
      // Last resort: treat last segment as controller name (Posts → posts_controller)
      const last = pathSegments[pathSegments.length - 1];
      const controllerPath = this.resolveControllerPath(
        this.ensureControllerSuffix(last),
        projectRoot,
      );
      if (!controllerPath) {
        return null;
      }
      const uri = vscode.Uri.file(controllerPath);
      if (!methodName) {
        return new vscode.Location(uri, new vscode.Position(0, 0));
      }
      return (
        this.findMethodInControllerFile(controllerPath, methodName) ||
        new vscode.Location(uri, new vscode.Position(0, 0))
      );
    }

    const location = this.resolveControllerFromImportPath(
      importPath,
      projectRoot,
    );
    if (!location) {
      return null;
    }

    if (!methodName) {
      return location;
    }

    return (
      this.findMethodInControllerFile(location.uri.fsPath, methodName) ||
      location
    );
  }

  private ensureControllerSuffix(name: string): string {
    if (/controller$/i.test(name)) {
      return name;
    }
    return `${name}Controller`;
  }

  private fallbackControllerImportFromSegments(
    pathSegments: string[],
  ): string | null {
    if (pathSegments.length === 0) {
      return null;
    }

    // Posts → posts_controller; auth/Login → auth/login_controller
    const dirs = pathSegments
      .slice(0, -1)
      .map((s) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
    const leaf = pathSegments[pathSegments.length - 1]
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase();
    const fileBase = /_controller$/.test(leaf) ? leaf : `${leaf}_controller`;
    const modulePath = [...dirs, fileBase].join("/");
    return `#controllers/${modulePath}`;
  }

  private lookupBarrelImportPath(
    projectRoot: string,
    pathSegments: string[],
  ): string | null {
    const barrelFile = this.findControllersBarrelFile(projectRoot);
    if (!barrelFile) {
      return null;
    }

    try {
      const text = fs.readFileSync(barrelFile, "utf8");
      const sourceFile = ts.createSourceFile(
        barrelFile,
        text,
        ts.ScriptTarget.Latest,
        true,
      );

      const controllersObject = this.findControllersExportObject(sourceFile);
      if (!controllersObject) {
        return null;
      }

      const property = this.findNestedObjectProperty(
        controllersObject,
        pathSegments,
      );
      if (!property?.initializer) {
        return null;
      }

      return this.extractDynamicImportPath(property.initializer);
    } catch (error) {
      console.error("Failed to read controllers barrel:", barrelFile, error);
      return null;
    }
  }

  private findControllersBarrelFile(projectRoot: string): string | null {
    const imports = this.getPackageImports(projectRoot);

    const exact =
      imports["#generated/controllers"] || imports["#generated/controllers.js"];
    if (typeof exact === "string") {
      const resolved = this.resolveMappedFile(projectRoot, exact);
      if (resolved) {
        return resolved;
      }
    }

    const wildcard = imports["#generated/*"];
    if (typeof wildcard === "string") {
      const mapped = wildcard.replace("*", "controllers");
      const resolved = this.resolveMappedFile(projectRoot, mapped);
      if (resolved) {
        return resolved;
      }
    }

    const fallbacks = [
      path.join(projectRoot, ".adonisjs", "server", "controllers.ts"),
      path.join(projectRoot, ".adonisjs", "server", "controllers.js"),
    ];
    for (const p of fallbacks) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  private resolveMappedFile(
    projectRoot: string,
    mapping: string,
  ): string | null {
    const resolvedPath = path.resolve(projectRoot, mapping);
    const candidates = [
      resolvedPath.replace(/\.js$/, ".ts"),
      resolvedPath,
      resolvedPath.replace(/\.ts$/, ".js"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  private findControllersExportObject(
    sourceFile: ts.SourceFile,
  ): ts.ObjectLiteralExpression | null {
    let found: ts.ObjectLiteralExpression | null = null;

    const visit = (node: ts.Node) => {
      if (found) {
        return;
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "controllers" &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        found = node.initializer;
        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return found;
  }

  private findNestedObjectProperty(
    objectLiteral: ts.ObjectLiteralExpression,
    pathSegments: string[],
  ): ts.PropertyAssignment | null {
    let current: ts.ObjectLiteralExpression | null = objectLiteral;
    let property: ts.PropertyAssignment | null = null;

    for (const segment of pathSegments) {
      if (!current) {
        return null;
      }

      property = null;
      for (const prop of current.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === segment
        ) {
          property = prop;
          break;
        }
      }

      if (!property) {
        return null;
      }

      if (
        property.initializer &&
        ts.isObjectLiteralExpression(property.initializer)
      ) {
        current = property.initializer;
      } else {
        current = null;
      }
    }

    return property;
  }

  private extractDynamicImportPath(expr: ts.Expression): string | null {
    // () => import('#controllers/...')
    if (ts.isArrowFunction(expr) && expr.body) {
      const body = expr.body;
      if (
        ts.isCallExpression(body) &&
        body.expression.kind === ts.SyntaxKind.ImportKeyword &&
        body.arguments.length > 0 &&
        ts.isStringLiteral(body.arguments[0])
      ) {
        return body.arguments[0].text;
      }

      if (ts.isParenthesizedExpression(body)) {
        return this.extractDynamicImportPath(body.expression);
      }

      if (ts.isBlock(body)) {
        for (const statement of body.statements) {
          if (ts.isReturnStatement(statement) && statement.expression) {
            return this.extractDynamicImportPath(statement.expression);
          }
        }
      }
    }

    // import('#controllers/...')
    if (
      ts.isCallExpression(expr) &&
      expr.expression.kind === ts.SyntaxKind.ImportKeyword &&
      expr.arguments.length > 0 &&
      ts.isStringLiteral(expr.arguments[0])
    ) {
      return expr.arguments[0].text;
    }

    return null;
  }

  private resolveControllerPath(
    controllerName: string,
    projectRoot: string,
  ): string | null {
    const imports = this.getPackageImports(projectRoot);
    const controllersMapping = imports["#controllers/*"];
    if (typeof controllersMapping !== "string") {
      return null;
    }

    const basePath = path.resolve(
      projectRoot,
      path.dirname(controllersMapping),
    );

    const snakeCaseName = controllerName
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase();

    const possiblePaths = [
      path.join(basePath, `${snakeCaseName}.ts`),
      path.join(basePath, `${snakeCaseName}.js`),
      path.join(basePath, controllerName, "index.ts"),
      path.join(basePath, controllerName, "index.js"),
      path.join(basePath, `${controllerName}.ts`),
      path.join(basePath, `${controllerName}.js`),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  private getPackageImports(projectRoot: string): Record<string, unknown> {
    const packageJsonPath = path.join(projectRoot, "package.json");
    try {
      const stat = fs.statSync(packageJsonPath);
      const cacheKey = packageJsonPath;

      if (this.cacheTimestamps.get(cacheKey) !== stat.mtime.getTime()) {
        const content = fs.readFileSync(packageJsonPath, "utf8");
        const packageJson = JSON.parse(content);
        this.importsCache.set(cacheKey, packageJson.imports || {});
        this.cacheTimestamps.set(cacheKey, stat.mtime.getTime());
      }

      return this.importsCache.get(cacheKey) || {};
    } catch {
      return {};
    }
  }

  private findMethodInControllerFile(
    controllerPath: string,
    methodName: string,
  ): vscode.Location | null {
    try {
      const text = fs.readFileSync(controllerPath, "utf8");
      const sourceFile = ts.createSourceFile(
        controllerPath,
        text,
        ts.ScriptTarget.Latest,
        true,
      );

      const best = this.findBestMethodNameNode(sourceFile, methodName);
      if (!best) {
        return null;
      }

      const startLc = ts.getLineAndCharacterOfPosition(
        sourceFile,
        best.getStart(sourceFile),
      );
      const endLc = ts.getLineAndCharacterOfPosition(sourceFile, best.getEnd());
      const start = new vscode.Position(startLc.line, startLc.character);
      const end = new vscode.Position(endLc.line, endLc.character);

      return new vscode.Location(
        vscode.Uri.file(controllerPath),
        new vscode.Range(start, end),
      );
    } catch (error) {
      console.error(
        "Failed to find method in controller file:",
        controllerPath,
        error,
      );
      return null;
    }
  }

  private findBestMethodNameNode(
    sourceFile: ts.SourceFile,
    methodName: string,
  ): ts.Identifier | null {
    const candidates: { node: ts.Identifier; priority: number }[] = [];

    const visit = (node: ts.Node) => {
      if (
        ts.isMethodDeclaration(node) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === methodName
      ) {
        let priority = 2;

        let parent: ts.Node = node.parent;
        while (parent) {
          if (
            ts.isClassDeclaration(parent) &&
            parent.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.ExportKeyword,
            ) &&
            parent.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
            )
          ) {
            priority = 1;
            break;
          }
          if (ts.isClassDeclaration(parent)) {
            priority = 2;
            break;
          }
          parent = parent.parent;
        }

        candidates.push({ node: node.name, priority });
      }

      if (
        ts.isPropertyDeclaration(node) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === methodName
      ) {
        candidates.push({ node: node.name, priority: 2 });
      }

      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === methodName &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        candidates.push({ node: node.name, priority: 3 });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0].node;
  }

  private resolveControllerFromImportPath(
    importPath: string,
    projectRoot: string,
  ): vscode.Location | null {
    const imports = this.getPackageImports(projectRoot);
    const mapping = imports[importPath];

    if (typeof mapping === "string") {
      const resolvedPath = path.resolve(projectRoot, mapping);
      const possiblePaths = [
        resolvedPath.replace(/\.js$/, ".ts"),
        resolvedPath,
        resolvedPath.replace(/\.ts$/, "/index.ts"),
        resolvedPath.replace(/\.js$/, "/index.js"),
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          return new vscode.Location(
            vscode.Uri.file(p),
            new vscode.Position(0, 0),
          );
        }
      }

      return null;
    }

    if (importPath.startsWith("#controllers/")) {
      const controllersMapping = imports["#controllers/*"];
      if (typeof controllersMapping !== "string") {
        return null;
      }

      const controllerModule = importPath.substring("#controllers/".length);
      const mappingPattern = controllersMapping;

      if (mappingPattern.includes("*")) {
        const mapped = mappingPattern.replace("*", controllerModule);
        const resolvedPath = path.resolve(projectRoot, mapped);
        const candidates = [
          resolvedPath.replace(/\.js$/, ".ts"),
          resolvedPath,
          resolvedPath.replace(/\.ts$/, "/index.ts"),
          resolvedPath.replace(/\.js$/, "/index.js"),
        ];

        for (const p of candidates) {
          if (fs.existsSync(p)) {
            return new vscode.Location(
              vscode.Uri.file(p),
              new vscode.Position(0, 0),
            );
          }
        }

        return null;
      }

      const basePath = path.resolve(projectRoot, path.dirname(mappingPattern));
      const candidates = [
        path.join(basePath, `${controllerModule}.ts`),
        path.join(basePath, `${controllerModule}.js`),
        path.join(basePath, controllerModule, "index.ts"),
        path.join(basePath, controllerModule, "index.js"),
      ];

      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return new vscode.Location(
            vscode.Uri.file(p),
            new vscode.Position(0, 0),
          );
        }
      }
    }

    return null;
  }

  private findControllerImportPath(
    variableName: string,
    sourceFile: ts.SourceFile,
  ): string | null {
    const visit = (node: ts.Node): string | null => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === variableName &&
        node.initializer
      ) {
        const fromInit = this.extractDynamicImportPath(node.initializer);
        if (fromInit) {
          return fromInit;
        }
      }

      return ts.forEachChild(node, visit) || null;
    };

    return visit(sourceFile);
  }

  private resolveRoutesModule(
    moduleName: string,
    projectRoot: string,
    sourceFile: ts.SourceFile,
  ): vscode.Location | null {
    const imports = this.getPackageImports(projectRoot);
    const routesMapping = imports["#routes/*"];
    if (typeof routesMapping === "string") {
      const basePath = path.resolve(
        projectRoot,
        routesMapping.replace("/*", ""),
      );
      const possiblePaths = [
        path.join(basePath, `${moduleName}.ts`),
        path.join(basePath, `${moduleName}.js`),
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          return new vscode.Location(
            vscode.Uri.file(p),
            new vscode.Position(0, 0),
          );
        }
      }
    }

    const currentDir = path.dirname(sourceFile.fileName);
    const localPath = path.join(currentDir, `${moduleName}.ts`);
    if (fs.existsSync(localPath)) {
      return new vscode.Location(
        vscode.Uri.file(localPath),
        new vscode.Position(0, 0),
      );
    }

    return null;
  }
}

interface ClickContext {
  type:
    | "controller_variable"
    | "controller_barrel"
    | "method_string"
    | "controller_import_path"
    | "routes_module";
  variableName?: string;
  controllerName?: string;
  methodName?: string;
  importPath?: string;
  moduleName?: string;
  barrelPath?: string[];
  /** Absolute offsets for partial highlight inside magic strings */
  selectionStart?: number;
  selectionEnd?: number;
}

interface HandlerInfo {
  type: "controller" | "controller_variable" | "controller_barrel";
  controllerName?: string;
  variableName?: string;
  methodName?: string;
  barrelPath?: string[];
}
