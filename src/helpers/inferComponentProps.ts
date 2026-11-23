const RESERVED_PROP_NAMES = new Set([
  "$props",
  "$slots",
  "$caller",
  "$filename",
  "$lineNumber",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "await",
  "new",
  "typeof",
  "instanceof",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "function",
  "const",
  "let",
  "var",
  "class",
  "import",
  "export",
  "default",
]);

/**
 * Infer prop names from an Edge component template (best-effort).
 */
export function inferComponentProps(source: string): string[] {
  const props = new Set<string>();

  const add = (name: string | undefined) => {
    if (!name || RESERVED_PROP_NAMES.has(name) || name.startsWith("$")) {
      return;
    }
    props.add(name);
  };

  // $props.get('x') / $props.has("x")
  const getHas = /\$props\s*\.\s*(?:get|has)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = getHas.exec(source)) !== null) {
    add(match[1]);
  }

  // $props.only(['a', 'b']) / $props.except(['a'])
  const onlyExcept =
    /\$props\s*\.\s*(?:only|except)\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
  while ((match = onlyExcept.exec(source)) !== null) {
    const inner = match[1];
    const keyRe = /['"]([^'"]+)['"]/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(inner)) !== null) {
      add(keyMatch[1]);
    }
  }

  // $props.merge({ key: ... }) / mergeIf / mergeUnless
  const mergeRe =
    /\$props\s*\.\s*(?:merge|mergeIf|mergeUnless)\s*\(\s*\{([\s\S]*?)\}/g;
  while ((match = mergeRe.exec(source)) !== null) {
    const body = match[1];
    const keyRe = /(?:^|,)\s*([a-zA-Z_$][\w$]*)\s*:/g;
    let keyMatch: RegExpExecArray | null;
    while ((keyMatch = keyRe.exec(body)) !== null) {
      add(keyMatch[1]);
    }
  }

  // {{ propName }} / {{{ propName }}} simple identifiers
  const mustache = /\{\{\{?\s*([a-zA-Z_$][\w$]*)\s*\}?\}\}/g;
  while ((match = mustache.exec(source)) !== null) {
    add(match[1]);
  }

  // HTML / attr bindings: name="{{ name }}" already covered; also type="{{ type || 'text' }}"
  const attrExpr =
    /\{\{\s*([a-zA-Z_$][\w$]*)\s*(?:\?\?|\|\||&&|\?|:)/g;
  while ((match = attrExpr.exec(source)) !== null) {
    add(match[1]);
  }

  return [...props].sort((a, b) => a.localeCompare(b));
}
