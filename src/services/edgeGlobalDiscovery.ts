import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { getPackageImports } from "../helpers/packageImports";
import { escapeRegExp, findBestMethodNameNode } from "../helpers/typescriptAst";
import type {
  EdgeGlobalBinding,
  EdgeGlobalUsageMatch,
  SourceRange,
} from "../interfaces/edgeGlobal";

const REGISTRATION_DIRS = ["start", "providers", "app/providers"];

/**
 * Discover `edge.global("Name", Binding)` registrations and resolve Binding
 * to a source file via imports / package.json `#aliases`.
 */
export function discoverEdgeGlobals(projectRoot: string): Map<string, EdgeGlobalBinding> {
  const map = new Map<string, EdgeGlobalBinding>();
  const files = collectRegistrationFiles(projectRoot);

  for (const filePath of files) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    if (!/\bedge\s*\.\s*global\s*\(/.test(text)) {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    for (const binding of findGlobalBindingsInFile(
      sourceFile,
      filePath,
      projectRoot,
    )) {
      if (!map.has(binding.globalName)) {
        map.set(binding.globalName, binding);
      }
    }
  }

  return map;
}

/**
 * Find `GlobalName` / `GlobalName.method` usages in Edge template text.
 * Underlines the global name and each method name separately.
 */
export function findEdgeGlobalUsages(
  text: string,
  globals: Map<string, EdgeGlobalBinding>,
): EdgeGlobalUsageMatch[] {
  if (globals.size === 0) {
    return [];
  }

  const matches: EdgeGlobalUsageMatch[] = [];
  const names = [...globals.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) {
    return matches;
  }

  const nameAlternation = names.map(escapeRegExp).join("|");
  // FormatterHelper or FormatterHelper.formatNumber
  const pattern = new RegExp(
    `\\b(${nameAlternation})(?:\\.([A-Za-z_$][\\w$]*))?\\b`,
    "g",
  );

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const globalName = match[1];
    const methodName = match[2];
    const binding = globals.get(globalName);
    if (!binding || !fs.existsSync(binding.filePath)) {
      continue;
    }

    // Underline the global identifier
    matches.push({
      offset: match.index,
      length: globalName.length,
      filePath: binding.filePath,
    });

    // Underline the method identifier (after the dot)
    if (methodName) {
      const methodOffset = match.index + globalName.length + 1;
      matches.push({
        offset: methodOffset,
        length: methodName.length,
        filePath: binding.filePath,
        methodName,
      });
    }
  }

  return matches;
}

/**
 * Locate a method/function name inside a helper module for Go to Definition.
 */
export function findMethodRangeInFile(
  filePath: string,
  methodName: string,
): SourceRange | null {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    const nameNode = findBestMethodNameNode(sourceFile, methodName);
    if (!nameNode) {
      return null;
    }

    const startLc = ts.getLineAndCharacterOfPosition(
      sourceFile,
      nameNode.getStart(sourceFile),
    );
    const endLc = ts.getLineAndCharacterOfPosition(
      sourceFile,
      nameNode.getEnd(),
    );
    return {
      startLine: startLc.line,
      startCharacter: startLc.character,
      endLine: endLc.line,
      endCharacter: endLc.character,
    };
  } catch {
    return null;
  }
}

function collectRegistrationFiles(projectRoot: string): string[] {
  const out: string[] = [];
  for (const dir of REGISTRATION_DIRS) {
    walkSourceFiles(path.join(projectRoot, dir), out);
  }
  return out;
}

function walkSourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      walkSourceFiles(full, out);
    } else if (
      entry.isFile() &&
      /\.(ts|js|mts|cts|mjs|cjs)$/i.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function findGlobalBindingsInFile(
  sourceFile: ts.SourceFile,
  registrationFile: string,
  projectRoot: string,
): EdgeGlobalBinding[] {
  const results: EdgeGlobalBinding[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isEdgeGlobalCallee(node.expression)) {
      const args = node.arguments;
      if (args.length >= 2) {
        const globalName = readStringLiteral(args[0]);
        if (globalName) {
          const resolved = resolveBindingToFile(
            args[1],
            sourceFile,
            registrationFile,
            projectRoot,
          );
          if (resolved) {
            results.push({ globalName, filePath: resolved });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return results;
}

/** `edge.global` / `edge["global"]` */
function isEdgeGlobalCallee(expr: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expr)) {
    return (
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "edge" &&
      expr.name.text === "global"
    );
  }
  if (ts.isElementAccessExpression(expr)) {
    return (
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "edge" &&
      expr.argumentExpression !== undefined &&
      ts.isStringLiteral(expr.argumentExpression) &&
      expr.argumentExpression.text === "global"
    );
  }
  return false;
}

function readStringLiteral(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function resolveBindingToFile(
  binding: ts.Expression,
  sourceFile: ts.SourceFile,
  registrationFile: string,
  projectRoot: string,
): string | null {
  if (ts.isIdentifier(binding)) {
    const importPath = findImportSpecifierForIdentifier(
      sourceFile,
      binding.text,
    );
    if (importPath) {
      const resolved = resolveModuleSpecifier(
        projectRoot,
        importPath,
        registrationFile,
      );
      if (resolved) {
        return resolved;
      }
    }
    // Local const/class in the same registration file
    return registrationFile;
  }

  // edge.global("x", SomeClass.method) — resolve object identifier if possible
  if (ts.isPropertyAccessExpression(binding) && ts.isIdentifier(binding.expression)) {
    const importPath = findImportSpecifierForIdentifier(
      sourceFile,
      binding.expression.text,
    );
    if (importPath) {
      const resolved = resolveModuleSpecifier(
        projectRoot,
        importPath,
        registrationFile,
      );
      if (resolved) {
        return resolved;
      }
    }
  }

  // Inline arrow/function — jump to the registration file
  return registrationFile;
}

function findImportSpecifierForIdentifier(
  sourceFile: ts.SourceFile,
  identifier: string,
): string | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;

    // import FormatterHelper from "…"
    if (
      clause.name &&
      ts.isIdentifier(clause.name) &&
      clause.name.text === identifier
    ) {
      return moduleSpecifier;
    }

    const bindings = clause.namedBindings;
    if (!bindings) {
      continue;
    }

    // import * as FormatterHelper from "…"
    if (
      ts.isNamespaceImport(bindings) &&
      bindings.name.text === identifier
    ) {
      return moduleSpecifier;
    }

    // import { FormatterHelper } / { Foo as FormatterHelper }
    if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.name.text === identifier) {
          return moduleSpecifier;
        }
      }
    }
  }
  return null;
}

function resolveModuleSpecifier(
  projectRoot: string,
  specifier: string,
  fromFile: string,
): string | null {
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    path.isAbsolute(specifier)
  ) {
    const base = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(path.dirname(fromFile), specifier);
    return firstExisting(fileCandidates(base));
  }

  const imports = getPackageImports(projectRoot);

  // Exact key: "#helpers/formatter_helper"
  const exact = imports[specifier];
  if (typeof exact === "string") {
    const hit = firstExisting(fileCandidates(path.resolve(projectRoot, exact)));
    if (hit) {
      return hit;
    }
  }

  // Wildcard: "#helpers/*" → "./app/helpers/*.js"
  for (const [pattern, mapping] of Object.entries(imports)) {
    if (typeof mapping !== "string" || !pattern.includes("*")) {
      continue;
    }
    const star = pattern.indexOf("*");
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
      continue;
    }
    const captured = specifier.slice(
      prefix.length,
      specifier.length - suffix.length,
    );
    const mapped = mapping.replace("*", captured);
    const hit = firstExisting(fileCandidates(path.resolve(projectRoot, mapped)));
    if (hit) {
      return hit;
    }
  }

  return null;
}

function fileCandidates(resolvedPath: string): string[] {
  const noExt = resolvedPath.replace(/\.(js|ts|mjs|cjs|mts|cts)$/i, "");
  return [
    `${noExt}.ts`,
    `${noExt}.tsx`,
    `${noExt}.js`,
    `${noExt}.mjs`,
    `${noExt}.cjs`,
    resolvedPath,
    path.join(noExt, "index.ts"),
    path.join(noExt, "index.js"),
  ];
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}
