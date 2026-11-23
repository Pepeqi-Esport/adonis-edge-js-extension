import * as ts from "typescript";

export function nameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface FindMethodNameOptions {
  /**
   * `controller`: only class methods/properties with identifier names and
   * exported function declarations (Adonis route handlers).
   * `helper` (default): also object-literal members, const arrow functions
   * and non-exported functions (edge.global helper modules).
   */
  scope?: "controller" | "helper";
}

/**
 * Find the best declaration name node for `methodName` in a source file.
 */
export function findBestMethodNameNode(
  sourceFile: ts.SourceFile,
  methodName: string,
  options: FindMethodNameOptions = {},
): ts.Node | null {
  const controllerScope = options.scope === "controller";
  const candidates: { node: ts.Node; priority: number }[] = [];

  const visit = (node: ts.Node) => {
    // class Foo { formatNumber() {} / static formatNumber() {} }
    if (
      ts.isMethodDeclaration(node) &&
      node.name &&
      (controllerScope
        ? ts.isIdentifier(node.name) && node.name.text === methodName
        : nameText(node.name) === methodName)
    ) {
      let priority = 2;
      let parent: ts.Node | undefined = node.parent;
      while (parent) {
        if (ts.isClassDeclaration(parent)) {
          const isDefaultExport = parent.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
          );
          const isExported = parent.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword,
          );
          priority = isDefaultExport && (!controllerScope || isExported) ? 1 : 2;
          break;
        }
        parent = parent.parent;
      }
      candidates.push({ node: node.name, priority });
    }

    // class field: formatNumber = () => {}
    if (
      ts.isPropertyDeclaration(node) &&
      node.name &&
      (controllerScope
        ? ts.isIdentifier(node.name) && node.name.text === methodName
        : nameText(node.name) === methodName)
    ) {
      candidates.push({ node: node.name, priority: 2 });
    }

    if (!controllerScope) {
      // object literal: { formatNumber() {} } / { formatNumber: () => {} }
      if (
        ts.isPropertyAssignment(node) &&
        nameText(node.name) === methodName &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        candidates.push({ node: node.name, priority: 2 });
      }

      if (
        ts.isMethodDeclaration(node) &&
        node.parent &&
        ts.isObjectLiteralExpression(node.parent) &&
        node.name &&
        nameText(node.name) === methodName
      ) {
        candidates.push({ node: node.name, priority: 2 });
      }
    }

    // export function formatNumber()
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.name.text === methodName
    ) {
      const isExported = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (controllerScope) {
        if (isExported) {
          candidates.push({ node: node.name, priority: 3 });
        }
      } else {
        candidates.push({ node: node.name, priority: isExported ? 3 : 4 });
      }
    }

    // const formatNumber = () => {}
    if (
      !controllerScope &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === methodName &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
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
