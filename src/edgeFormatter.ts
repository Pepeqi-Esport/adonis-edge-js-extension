import * as vscode from "vscode";

/** Same modes as shufo/blade-formatter (js-beautify wrap_attributes). */
type WrapAttributesMode =
  | "auto"
  | "force"
  | "force-aligned"
  | "force-expand-multiline"
  | "aligned-multiple"
  | "preserve"
  | "preserve-aligned";

interface EdgeFormatConfig {
  indentSize: number;
  preserveNewLines: boolean;
  maxPreserveNewLines: number;
  /** Like Prettier printWidth / blade wrapLineLength. */
  printWidth: number;
  /** Blade-formatter-compatible attribute wrap style. */
  wrapAttributes: WrapAttributesMode;
  /** Min attrs before force* modes wrap (blade wrapAttributesMinAttrs). */
  wrapAttributesMinAttrs: number;
  /** When true, collapse short label/button/etc. blocks onto one line. Off by default. */
  collapseShortBlocks: boolean;
}

/**
 * Edge block directives that increase indentation.
 */
const BLOCK_OPEN_TAGS = [
  "component",
  "slot",
  "if",
  "each",
  "unless",
  "forelse",
  "section",
  "stack",
  "push",
  "prepend",
];
/**
 * Mid-block directives that temporarily decrease then re-increase indent.
 */
const MID_BLOCK_TAGS = ["else", "elseif"];
/**
 * Closing directives that decrease indentation.
 */
const BLOCK_CLOSE_TAGS = [
  "end",
  "endsection",
  "endstack",
  "endpush",
  "endprepend",
];
/**
 * Inline directives that don't affect indentation.
 */
const INLINE_TAGS = ["include", "set", "inject", "break", "continue"];
// Regex patterns
const EDGE_BLOCK_OPEN = new RegExp(`^\\s*@(${BLOCK_OPEN_TAGS.join("|")})\\b`);
const EDGE_MID_BLOCK = new RegExp(`^\\s*@(${MID_BLOCK_TAGS.join("|")})\\b`);
const EDGE_BLOCK_CLOSE = new RegExp(`^\\s*@(${BLOCK_CLOSE_TAGS.join("|")})\\b`);
const EDGE_INLINE = new RegExp(`^\\s*@(${INLINE_TAGS.join("|")})\\b`);
const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
// Script and style blocks
const SCRIPT_STYLE_CLOSE = /^(\s*)<\/(script|style)\s*>\s*$/i;
/**
 * Smart HTML tag detection that handles `>` inside quoted attributes
 * and `{{ }}` Edge expressions (e.g. arrow functions `cd => cd.status`).
 *
 * Returns { tagName, isSelfClosing } or null if not a valid HTML tag line.
 */
function detectHtmlTag(
  trimmed: string,
): { tagName: string; isSelfClosing: boolean } | null {
  // Must start with <tagname
  const tagMatch = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9-]*)\b/);
  if (!tagMatch) return null;
  // Must not be a closing tag
  if (trimmed.startsWith("</")) return null;
  const tagName = tagMatch[1];
  // Walk through the string tracking quote and expression state
  // to find the REAL closing > of the tag
  let inSingle = false;
  let inDouble = false;
  let inExpr = 0; // depth of {{ }}
  let closingIdx = -1;
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const next = trimmed[i + 1] || "";
    // Track Edge expressions {{ }}
    if (!inSingle && !inDouble) {
      if (ch === "{" && next === "{") {
        inExpr++;
        i++; // skip next {
        continue;
      }
      if (ch === "}" && next === "}" && inExpr > 0) {
        inExpr--;
        i++; // skip next }
        continue;
      }
    }
    // Track quotes (outside expressions)
    if (inExpr === 0) {
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
    }
    // Only match > when outside quotes AND outside expressions
    if (!inSingle && !inDouble && inExpr === 0 && ch === ">") {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) return null;
  // Check if everything after the > is just whitespace
  const afterClose = trimmed.substring(closingIdx + 1).trim();
  if (afterClose !== "") return null;
  // Check if self-closing: character before > is /
  const isSelfClosing = trimmed[closingIdx - 1] === "/";
  return { tagName, isSelfClosing };
}
/**
 * Check if a line is a <script> or <style> opening tag.
 * Uses smart parsing to handle expressions in attributes.
 */
function isScriptStyleOpen(trimmed: string): false | "script" | "style" {
  const result = detectHtmlTag(trimmed);
  if (!result || result.isSelfClosing) return false;
  const lower = result.tagName.toLowerCase();
  if (lower === "script") return "script";
  if (lower === "style") return "style";
  return false;
}
// CSS brace patterns for style block formatting
const CSS_OPEN_BRACE = /\{\s*$/;
const CSS_CLOSE_BRACE = /^\s*\}/;
function getConfig(): EdgeFormatConfig {
  const config = vscode.workspace.getConfiguration("edge.format");
  // Prefer printWidth (Prettier-style); fall back to deprecated wrapLineLength.
  const printWidth =
    config.get<number>("printWidth") ??
    config.get<number>("wrapLineLength") ??
    140;
  return {
    indentSize: config.get("indentSize", 4),
    preserveNewLines: config.get("preserveNewLines", true),
    maxPreserveNewLines: config.get("maxPreserveNewLines", 2),
    printWidth,
    // Default `auto` matches shufo/blade-formatter: pack attrs until printWidth, then continue
    wrapAttributes: config.get<WrapAttributesMode>("wrapAttributes", "auto"),
    wrapAttributesMinAttrs: config.get<number>("wrapAttributesMinAttrs", 2),
    collapseShortBlocks: config.get("collapseShortBlocks", false),
  };
}
// ─── PRE-PROCESSING: Join multi-line attributes into single lines ────────────
/**
 * Joins HTML tags whose attributes span multiple lines into a single line.
 *
 * Handles patterns like:
 *   <div style="           <circle style="
 *     display: grid;         transform: rotate(-90deg);
 *     gap: 24px;           " />
 *   ">
 *
 * Also handles multi-line tags without quotes (attribute per line):
 *   <circle
 *     class="ring"
 *     cx="70"
 *     cy="70"
 *   ></circle>
 */
function joinMultiLineAttributes(lines: string[]): string[] {
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip blank lines, Edge directives, Edge expressions, comments
    if (
      trimmed === "" ||
      trimmed.startsWith("@") ||
      trimmed.startsWith("{{") ||
      trimmed.startsWith("<!--")
    ) {
      result.push(line);
      i++;
      continue;
    }
    // Check if this line opens an HTML tag but doesn't close it with >
    // e.g. `<div style="` or `<circle class="foo"` without closing >
    if (isIncompleteTag(trimmed)) {
      // Accumulate lines until we find the closing >
      let accumulated = trimmed;
      let j = i + 1;
      while (j < lines.length) {
        const nextTrimmed = lines[j].trim();
        if (nextTrimmed === "") {
          j++;
          continue;
        }
        // Join with space, collapsing whitespace
        accumulated = accumulated + " " + nextTrimmed;
        // Check if tag is now complete (has closing >)
        if (isTagComplete(accumulated)) {
          break;
        }
        j++;
      }
      // Collapse internal whitespace in the joined line
      accumulated = collapseMultiLineAttribute(accumulated);
      // Preserve leading whitespace from original line
      const leadingWhitespace = line.match(/^(\s*)/)?.[1] || "";
      result.push(leadingWhitespace + accumulated);
      i = j + 1;
      continue;
    }
    // Check for a line that has an unclosed quote in a style/class attribute
    // e.g. `<div class="device-grid" style="`
    // where the attribute value continues on next lines
    if (hasUnclosedAttributeQuote(trimmed)) {
      let accumulated = trimmed;
      let j = i + 1;
      while (j < lines.length) {
        const nextTrimmed = lines[j].trim();
        if (nextTrimmed === "") {
          j++;
          continue;
        }
        // Join attribute values with space, replacing newlines
        accumulated = accumulated + " " + nextTrimmed;
        // Check if all quotes are now balanced and tag is complete
        if (areQuotesBalanced(accumulated) && isTagComplete(accumulated)) {
          break;
        }
        j++;
      }
      accumulated = collapseMultiLineAttribute(accumulated);
      const leadingWhitespace = line.match(/^(\s*)/)?.[1] || "";
      result.push(leadingWhitespace + accumulated);
      i = j + 1;
      continue;
    }
    result.push(line);
    i++;
  }
  return result;
}
/**
 * Check if a line starts an HTML tag that isn't closed on this line.
 * e.g. `<div style="` or `<circle` without a closing `>`
 */
function isIncompleteTag(trimmed: string): boolean {
  // Must start with < and a tag name
  if (!trimmed.match(/^<[a-zA-Z]/)) return false;
  // If it's a closing tag, it's not incomplete
  if (trimmed.startsWith("</")) return false;
  // Check if the tag is complete (has its closing >)
  if (isTagComplete(trimmed)) return false;
  return true;
}
/**
 * Check if an HTML tag string has its closing > (accounting for quotes).
 */
function isTagComplete(str: string): boolean {
  // Walk through the string tracking quote state
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (!inSingle && !inDouble) {
      if (ch === "<") {
        depth++;
      } else if (ch === ">") {
        depth--;
        if (depth <= 0) return true;
      }
    }
  }
  return false;
}
/**
 * Check if a line has an unclosed attribute quote.
 * e.g. `<div style="` has an odd number of quotes after the last `="`
 */
function hasUnclosedAttributeQuote(trimmed: string): boolean {
  // Must be inside an HTML tag
  if (!trimmed.match(/^<[a-zA-Z]/)) return false;
  if (trimmed.startsWith("</")) return false;
  // Count quotes to see if they're balanced
  return !areQuotesBalanced(trimmed);
}
/**
 * Check if all quotes in a string are balanced.
 */
function areQuotesBalanced(str: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    }
  }
  return !inSingle && !inDouble;
}
/**
 * Collapse a joined multi-line attribute into a clean single line.
 * - Collapses runs of whitespace into single spaces
 * - Cleans up CSS values inside style="" by joining with "; "
 */
function collapseMultiLineAttribute(str: string): string {
  // Collapse all runs of whitespace (including newlines) into single space
  let result = str.replace(/\s+/g, " ");
  // Clean up style attributes: normalize semicolons and spacing
  result = result.replace(
    /(style\s*=\s*")([^"]*?)(")/gi,
    (_match, prefix, value, suffix) => {
      // Normalize the CSS value
      let css = value
        .replace(/\s*;\s*/g, "; ") // normalize around semicolons
        .replace(/\s*:\s*/g, ": ") // normalize around colons
        .trim();
      // Remove trailing semicolon before closing quote
      if (css.endsWith(";")) {
        css = css.slice(0, -1).trim();
      }
      // Re-add trailing semicolon for valid CSS
      if (css && !css.endsWith(";")) {
        css += ";";
      }
      return prefix + css + suffix;
    },
  );
  return result;
}

/**
 * Split the attribute region of an HTML open tag into individual attributes.
 * Handles quotes and `{{ }}` Edge expressions inside values.
 */
function splitHtmlAttributes(attrRegion: string): string[] {
  const attrs: string[] = [];
  let i = 0;
  const s = attrRegion.trim();

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) {
      i++;
    }
    if (i >= s.length) {
      break;
    }

    const start = i;
    // Attribute name
    while (i < s.length && /[^\s=]/.test(s[i])) {
      i++;
    }
    if (i < s.length && s[i] === "=") {
      i++; // skip =
      if (i < s.length && (s[i] === '"' || s[i] === "'")) {
        const quote = s[i];
        i++; // opening quote
        let inExpr = 0;
        while (i < s.length) {
          const ch = s[i];
          const next = s[i + 1] || "";
          if (ch === "{" && next === "{") {
            inExpr++;
            i += 2;
            continue;
          }
          if (ch === "}" && next === "}" && inExpr > 0) {
            inExpr--;
            i += 2;
            continue;
          }
          if (inExpr === 0 && ch === quote) {
            i++; // closing quote
            break;
          }
          i++;
        }
      } else {
        // Unquoted value — stop at whitespace
        while (i < s.length && !/\s/.test(s[i])) {
          i++;
        }
      }
    }

    const attr = s.slice(start, i).trim();
    if (attr) {
      attrs.push(attr);
    }
  }

  return attrs;
}

/**
 * Parse a single-line HTML open tag into tag name + attributes.
 * Returns null if the line isn't a complete open tag (or has trailing content).
 */
function parseHtmlOpenTagForWrap(
  trimmed: string,
): {
  tagName: string;
  attributes: string[];
  isSelfClosing: boolean;
} | null {
  const detected = detectHtmlTag(trimmed);
  if (!detected) {
    return null;
  }

  const tagMatch = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9-]*)\b/);
  if (!tagMatch) {
    return null;
  }

  // Find real closing > (same rules as detectHtmlTag)
  let inSingle = false;
  let inDouble = false;
  let inExpr = 0;
  let closingIdx = -1;
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const next = trimmed[i + 1] || "";
    if (!inSingle && !inDouble) {
      if (ch === "{" && next === "{") {
        inExpr++;
        i++;
        continue;
      }
      if (ch === "}" && next === "}" && inExpr > 0) {
        inExpr--;
        i++;
        continue;
      }
    }
    if (inExpr === 0) {
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
    }
    if (!inSingle && !inDouble && inExpr === 0 && ch === ">") {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    return null;
  }

  const isSelfClosing = trimmed[closingIdx - 1] === "/";
  const attrEnd = isSelfClosing ? closingIdx - 1 : closingIdx;
  const attrRegion = trimmed.slice(tagMatch[0].length, attrEnd);
  const attributes = splitHtmlAttributes(attrRegion);

  if (attributes.length === 0) {
    return null;
  }

  return {
    tagName: detected.tagName,
    attributes,
    isSelfClosing,
  };
}

function closingBracket(
  leading: string,
  isSelfClosing: boolean,
  ownLine: boolean,
): string {
  if (isSelfClosing) {
    return ownLine ? `${leading}/>` : "/>";
  }
  return ownLine ? `${leading}>` : ">";
}

/**
 * Pack attributes onto lines up to printWidth (blade-formatter `auto` /
 * `aligned-multiple` style). First line starts with `prefix` (e.g. `    <input`).
 */
function packAttributesToWidth(
  prefix: string,
  attrs: string[],
  continuationIndent: string,
  printWidth: number,
  close: string,
): string[] {
  if (attrs.length === 0) {
    return [`${prefix}${close}`];
  }

  const lines: string[] = [];
  let current = prefix;

  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    const isLast = i === attrs.length - 1;
    const next = `${current} ${attr}`;
    const nextWithClose = isLast ? `${next}${close}` : next;
    const wouldOverflow = nextWithClose.length > printWidth;

    // Always place at least one attribute on the current line when it's still
    // just the tag open (matches js-beautify / blade-formatter auto).
    if (!wouldOverflow || current === prefix) {
      current = next;
      if (isLast) {
        lines.push(`${current}${close}`);
      }
      continue;
    }

    lines.push(current);
    current = `${continuationIndent}${attr}`;
    if (isLast) {
      lines.push(`${current}${close}`);
    }
  }

  return lines;
}

/**
 * Wrap HTML open tags like shufo/blade-formatter (js-beautify wrap_attributes).
 */
function wrapLongHtmlTags(
  lines: string[],
  printWidth: number,
  indentSize: number,
  wrapAttributes: WrapAttributesMode,
  wrapAttributesMinAttrs: number,
): string[] {
  if (wrapAttributes === "preserve" || wrapAttributes === "preserve-aligned") {
    return lines;
  }

  const result: string[] = [];
  let insideScriptStyle = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (isScriptStyleOpen(trimmed)) {
      insideScriptStyle = true;
      result.push(line);
      continue;
    }
    if (
      SCRIPT_STYLE_CLOSE.test(line) ||
      /^<\/(script|style)\s*>/i.test(trimmed)
    ) {
      insideScriptStyle = false;
      result.push(line);
      continue;
    }
    if (insideScriptStyle) {
      result.push(line);
      continue;
    }

    if (!trimmed.startsWith("<") || trimmed.startsWith("</")) {
      result.push(line);
      continue;
    }

    const parsed = parseHtmlOpenTagForWrap(trimmed);
    if (!parsed) {
      result.push(line);
      continue;
    }

    const attrCount = parsed.attributes.length;
    const exceedsWidth = line.length > printWidth;
    const meetsMinAttrs = attrCount >= wrapAttributesMinAttrs;

    let shouldWrap = false;
    switch (wrapAttributes) {
      case "auto":
      case "aligned-multiple":
        shouldWrap = exceedsWidth && attrCount >= 1;
        break;
      case "force":
      case "force-aligned":
      case "force-expand-multiline":
        shouldWrap = meetsMinAttrs;
        break;
    }

    if (!shouldWrap) {
      result.push(line);
      continue;
    }

    const leading = line.match(/^(\s*)/)?.[1] || "";
    const attrIndent = leading + " ".repeat(indentSize);
    const tagOpen = `${leading}<${parsed.tagName}`;
    const closeOwnLine = wrapAttributes === "force-expand-multiline";
    const close = closingBracket(leading, parsed.isSelfClosing, closeOwnLine);

    if (wrapAttributes === "force-expand-multiline") {
      // <input
      //     type="text"
      //     class="foo"
      // >
      result.push(tagOpen);
      for (const attr of parsed.attributes) {
        result.push(`${attrIndent}${attr}`);
      }
      result.push(close);
      continue;
    }

    if (wrapAttributes === "force" || wrapAttributes === "force-aligned") {
      // <input type="text"
      //     class="foo"
      //     name="price">
      // force-aligned aligns continuation under the first attribute.
      const [first, ...rest] = parsed.attributes;
      const firstLine = `${tagOpen} ${first}`;
      if (rest.length === 0) {
        result.push(
          `${firstLine}${closingBracket("", parsed.isSelfClosing, false)}`,
        );
        continue;
      }

      const alignedIndent =
        wrapAttributes === "force-aligned"
          ? " ".repeat(firstLine.length - first.length)
          : attrIndent;

      result.push(firstLine);
      rest.forEach((attr, idx) => {
        const isLast = idx === rest.length - 1;
        if (isLast) {
          result.push(
            `${alignedIndent}${attr}${closingBracket("", parsed.isSelfClosing, false)}`,
          );
        } else {
          result.push(`${alignedIndent}${attr}`);
        }
      });
      continue;
    }

    // auto / aligned-multiple: pack attrs to printWidth
    const continuationIndent =
      wrapAttributes === "aligned-multiple"
        ? " ".repeat(Math.min(tagOpen.length + 1, printWidth - 1))
        : attrIndent;
    const packed = packAttributesToWidth(
      tagOpen,
      parsed.attributes,
      continuationIndent,
      printWidth,
      closingBracket("", parsed.isSelfClosing, false),
    );
    result.push(...packed);
  }

  return result;
}

// ─── PRE-PROCESSING: Split inline Edge directives to their own lines ─────────
/**
 * All Edge block directives that should be on their own line.
 * This includes open, close, and mid-block directives.
 */
const ALL_BLOCK_DIRECTIVES = [
  ...BLOCK_OPEN_TAGS,
  ...MID_BLOCK_TAGS,
  ...BLOCK_CLOSE_TAGS,
  "stack",
  "endstack",
  "push",
  "endpush",
  "prepend",
  "endprepend",
];
const INLINE_DIRECTIVE_SPLIT = new RegExp(
  `@(${ALL_BLOCK_DIRECTIVES.join("|")})\\b`,
);
/**
 * Splits lines where Edge block directives appear inline with other content.
 *
 * Examples:
 *   "Submit@end"           → ["Submit", "@end"]
 *   "Create Field@end"     → ["Create Field", "@end"]
 *   "<h1>Title</h1>@end"   → ["<h1>Title</h1>", "@end"]
 *   "@if(user)<div>hi</div>" → ["@if(user)", "<div>hi</div>"]
 *   "@if(x)@end"           → ["@if(x)", "@end"]
 *
 * Lines that are purely an Edge directive (with optional whitespace) are left alone.
 * Lines inside <script> or <style> blocks are skipped.
 */
function splitInlineDirectives(lines: string[]): string[] {
  const result = [];
  let insideScriptStyle = false;
  for (const line of lines) {
    const trimmed = line.trim();
    // Track script/style blocks — don't touch their contents
    if (/^<(script|style)\b/i.test(trimmed)) {
      insideScriptStyle = true;
      result.push(line);
      continue;
    }
    if (/^<\/(script|style)\s*>/i.test(trimmed)) {
      insideScriptStyle = false;
      result.push(line);
      continue;
    }
    if (insideScriptStyle) {
      result.push(line);
      continue;
    }
    // Skip blank lines and lines inside {{ }} expressions
    if (trimmed === "") {
      result.push(line);
      continue;
    }
    // Get leading whitespace for preserving indentation
    const leadingWs = line.match(/^(\s*)/)?.[1] || "";
    // Split the trimmed line at Edge directive boundaries
    const parts = splitAtDirectives(trimmed);
    if (parts.length <= 1) {
      // No splitting needed
      result.push(line);
    } else {
      // Push each part as its own line with original leading whitespace
      for (const part of parts) {
        const p = part.trim();
        if (p !== "") {
          result.push(leadingWs + p);
        }
      }
    }
  }
  return result;
}
/**
 * Splits a trimmed line at Edge directive boundaries, respecting:
 * - Quoted strings (don't split inside quotes)
 * - Edge expressions {{ }} (don't split inside them)
 * - Directive arguments with parentheses @if(...)
 *
 * Returns an array of parts. If no split is needed, returns [original].
 */
function splitAtDirectives(trimmed: string): string[] {
  // If the line is purely a directive (possibly with args), no split needed
  const pureDirective = new RegExp(
    `^@(${ALL_BLOCK_DIRECTIVES.join("|")})\\b(\\([^)]*\\))?\\s*$`,
  );
  if (pureDirective.test(trimmed)) {
    return [trimmed];
  }
  // If line doesn't contain any block directive, no split needed
  if (!INLINE_DIRECTIVE_SPLIT.test(trimmed)) {
    return [trimmed];
  }
  const parts = [];
  let current = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inExpr = 0; // depth of {{ }}
  while (i < trimmed.length) {
    const ch = trimmed[i];
    const next = trimmed[i + 1] || "";
    // Track quote state (outside expressions)
    if (ch === '"' && !inSingle && inExpr === 0) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble && inExpr === 0) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    // Track Edge expression {{ }}
    if (!inSingle && !inDouble) {
      if (ch === "{" && next === "{") {
        inExpr++;
        current += "{{";
        i += 2;
        continue;
      }
      if (ch === "}" && next === "}" && inExpr > 0) {
        inExpr--;
        current += "}}";
        i += 2;
        continue;
      }
    }
    // Only split when outside quotes and expressions
    if (!inSingle && !inDouble && inExpr === 0) {
      // Check if @ starts a block directive here
      if (ch === "@") {
        const remaining = trimmed.substring(i);
        const directiveMatch = remaining.match(
          new RegExp(`^@(${ALL_BLOCK_DIRECTIVES.join("|")})\\b`),
        );
        if (directiveMatch) {
          // Push whatever was before this directive
          const before = current.trim();
          if (before !== "") {
            parts.push(before);
          }
          // Capture the directive and its arguments
          let directive = directiveMatch[0];
          let j = i + directive.length;
          // If followed by parentheses, capture the full argument
          if (j < trimmed.length && trimmed[j] === "(") {
            let parenDepth = 0;
            let k = j;
            while (k < trimmed.length) {
              if (trimmed[k] === "(") parenDepth++;
              if (trimmed[k] === ")") {
                parenDepth--;
                if (parenDepth === 0) {
                  k++;
                  break;
                }
              }
              k++;
            }
            directive = trimmed.substring(i, k);
            j = k;
          }
          // Check if what follows is just whitespace or end of line
          const afterDirective = trimmed.substring(j).trim();
          if (afterDirective === "") {
            // Nothing after — just push the directive
            parts.push(directive);
            current = "";
            i = trimmed.length;
          } else {
            // More content after the directive — push directive, continue with rest
            parts.push(directive);
            current = "";
            i = j;
          }
          continue;
        }
      }
    }
    current += ch;
    i++;
  }
  // Push any remaining content
  const remaining = current.trim();
  if (remaining !== "") {
    parts.push(remaining);
  }
  return parts.length > 1 ? parts : [trimmed];
}
// ─── PRE-PROCESSING: Fix broken HTML tags split across lines ─────────────────
/**
 * Fixes HTML tags that are broken across lines.
 *
 * Common patterns:
 *   </span         →  </span>
 *   >
 *
 *   <span style="color: #4ade80">Yes</span   →  <span style="color: #4ade80">Yes</span>
 *   >
 *
 *   </span          →  </span>
 *     >
 *
 * This handles both opening and closing tags where the `>` has been pushed
 * to the next line. The formatter joins them back into a single line.
 */
function fixBrokenHtmlTags(lines: string[]): string[] {
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    // Check if this line ends with an incomplete HTML tag (no closing >)
    // Pattern: line ends with a tag-like structure but no >
    // e.g. `</span` or `<span style="color: #4ade80">Yes</span` or `>{{ value }}</span`
    if (trimmed.length > 0 && endsWithBrokenTag(trimmed)) {
      // Look ahead to see if next non-empty line is just `>` or starts with `>`
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") {
        j++;
      }
      if (j < lines.length) {
        const nextTrimmed = lines[j].trim();
        // Next line is just `>` or starts with `>` followed by nothing significant
        if (
          nextTrimmed === ">" ||
          nextTrimmed === "/>" ||
          /^\/?>[\s]*$/.test(nextTrimmed)
        ) {
          // Join the broken tag
          const leadingWs = lines[i].match(/^(\s*)/)?.[1] || "";
          result.push(leadingWs + trimmed + nextTrimmed.trim());
          i = j + 1;
          continue;
        }
      }
    }
    result.push(lines[i]);
    i++;
  }
  return result;
}
/**
 * Check if a line ends with a broken HTML tag (missing its closing >).
 * e.g. `</span` or `Yes</span` or `<div class="foo"` (without >)
 */
function endsWithBrokenTag(trimmed: string): boolean {
  // Pattern: ends with </tagname (closing tag without >)
  if (/\/[a-zA-Z][a-zA-Z0-9-]*\s*$/.test(trimmed)) {
    return true;
  }
  // Pattern: ends with a tag attribute or tag name without >
  // e.g. `<div class="foo"` or `<input type="text"`
  if (/^<[a-zA-Z]/.test(trimmed) && !isTagComplete(trimmed)) {
    return true;
  }
  return false;
}
// ─── PRE-PROCESSING: Convert simple @if/@else/@end to ternary ────────────────
/**
 * Converts simple @if(condition) / @else / @end blocks to ternary expressions.
 *
 * Only converts when:
 * - Both branches are simple text (no HTML tags, no nested directives)
 * - Each branch is a single short value (1-3 words, < 40 chars)
 * - The block is a straightforward if/else/end (no elseif)
 *
 * Before:
 *   @if(theme?.pricing.is_free)
 *     Free
 *   @else
 *     Paid
 *   @end
 *
 * After:
 *   {{ theme?.pricing.is_free ? 'Free' : 'Paid' }}
 */
function convertSimpleIfElseToTernary(lines: string[]): string[] {
  const result = [];
  let i = 0;
  let insideScriptStyle = false;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    // Track script/style blocks — don't touch their contents
    if (/^<(script|style)\b/i.test(trimmed)) {
      insideScriptStyle = true;
      result.push(lines[i]);
      i++;
      continue;
    }
    if (/^<\/(script|style)\s*>/i.test(trimmed)) {
      insideScriptStyle = false;
      result.push(lines[i]);
      i++;
      continue;
    }
    if (insideScriptStyle) {
      result.push(lines[i]);
      i++;
      continue;
    }
    // Look for @if(condition) pattern
    const ifMatch = trimmed.match(/^@if\((.+)\)\s*$/);
    if (ifMatch) {
      // Try to match the pattern: @if → value → @else → value → @end
      const condition = ifMatch[1];
      const leadingWs = lines[i].match(/^(\s*)/)?.[1] || "";
      // Collect lines until we find @else or @end
      let j = i + 1;
      let trueValue = "";
      let falseValue = "";
      let foundElse = false;
      let foundEnd = false;
      let tooComplex = false;
      // Collect true branch
      while (j < lines.length) {
        const lineT = lines[j].trim();
        if (lineT === "") {
          j++;
          continue;
        }
        if (/^@else\s*$/.test(lineT)) {
          foundElse = true;
          j++;
          break;
        }
        if (/^@(end|elseif)\b/.test(lineT)) {
          // No @else — this is just @if/@end, not convertible to simple ternary
          tooComplex = true;
          break;
        }
        // Check if this line is simple text (no HTML, no directives, no expressions)
        if (isSimpleTernaryValue(lineT)) {
          if (trueValue !== "") {
            tooComplex = true;
            break;
          }
          trueValue = lineT;
        } else {
          tooComplex = true;
          break;
        }
        j++;
      }
      // Collect false branch
      if (foundElse && !tooComplex) {
        while (j < lines.length) {
          const lineT = lines[j].trim();
          if (lineT === "") {
            j++;
            continue;
          }
          if (/^@end\s*$/.test(lineT)) {
            foundEnd = true;
            j++;
            break;
          }
          if (/^@(elseif|else)\b/.test(lineT)) {
            tooComplex = true;
            break;
          }
          if (isSimpleTernaryValue(lineT)) {
            if (falseValue !== "") {
              tooComplex = true;
              break;
            }
            falseValue = lineT;
          } else {
            tooComplex = true;
            break;
          }
          j++;
        }
      }
      // Convert if all conditions met
      if (foundElse && foundEnd && !tooComplex && trueValue && falseValue) {
        const trueQuoted = quoteTernaryValue(trueValue);
        const falseQuoted = quoteTernaryValue(falseValue);
        const ternary = `{{ ${condition} ? ${trueQuoted} : ${falseQuoted} }}`;
        result.push(leadingWs + ternary);
        i = j;
        continue;
      }
    }
    result.push(lines[i]);
    i++;
  }
  return result;
}
/**
 * Check if a value is simple enough to be used in a ternary expression.
 * Simple = plain text, no HTML tags, no Edge directives, no Edge expressions.
 * Max 40 characters.
 */
function isSimpleTernaryValue(value: string): boolean {
  // Must not contain HTML tags
  if (/<[a-zA-Z]/.test(value)) return false;
  if (/<\//.test(value)) return false;
  // Must not contain Edge directives
  if (/@[a-zA-Z]/.test(value)) return false;
  // Must not contain Edge expressions
  if (/\{\{/.test(value)) return false;
  // Must be short (max 40 chars)
  if (value.length > 40) return false;
  // Must not be empty
  if (value.trim() === "") return false;
  return true;
}
/**
 * Quote a ternary value. If it's already quoted, leave it.
 * Otherwise wrap in single quotes.
 */
function quoteTernaryValue(value: string): string {
  // If value is a number, don't quote
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  // If already quoted, return as-is
  if (/^['"].*['"]$/.test(value)) return value;
  // If it contains single quotes, use double quotes
  if (value.includes("'")) return `"${value}"`;
  // Otherwise use single quotes
  return `'${value}'`;
}
// ─── PRE-PROCESSING: Collapse short multi-line HTML blocks ───────────────────
/**
 * Collapses HTML blocks where a short text content is spread across
 * multiple lines between an opening and closing tag.
 *
 * Before:
 *   <a href="/pages" class="btn btn-secondary px-4 py-2">
 *
 *     Cancel
 *   </a>
 *
 * After:
 *   <a href="/pages" class="btn btn-secondary px-4 py-2">Cancel</a>
 *
 * Also handles:
 *   <button class="btn">
 *     {{ record ? 'Update' : 'Create' }}
 *   </button>
 *   →  <button class="btn">{{ record ? 'Update' : 'Create' }}</button>
 *
 * Rules:
 * - Only ONE non-empty content line between open and close tags
 * - Content must be short (< 60 chars)
 * - No nested HTML tags or Edge block directives in content
 * - Collapsed result must be under printWidth (default 140)
 * - Close tag must match the open tag
 */
function collapseShortHtmlBlocks(
  lines: string[],
  printWidth = 140,
): string[] {
  const result = [];
  let i = 0;
  let insideScriptStyle = false;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    // Track script/style blocks
    if (/^<(script|style)\b/i.test(trimmed)) {
      insideScriptStyle = true;
      result.push(lines[i]);
      i++;
      continue;
    }
    if (/^<\/(script|style)\s*>/i.test(trimmed)) {
      insideScriptStyle = false;
      result.push(lines[i]);
      i++;
      continue;
    }
    if (insideScriptStyle) {
      result.push(lines[i]);
      i++;
      continue;
    }
    // Detect HTML open tag that ends with > and is the only thing on the line
    const openTag = detectHtmlTag(trimmed);
    if (
      openTag &&
      !openTag.isSelfClosing &&
      !HTML_VOID_ELEMENTS.has(openTag.tagName.toLowerCase())
    ) {
      const tagName = openTag.tagName;
      const closePattern = new RegExp(`^\\s*</${tagName}\\s*>\\s*$`, "i");
      const closeInline = new RegExp(`</${tagName}\\s*>\\s*$`, "i");
      // Look ahead: collect non-empty content lines until close tag
      let j = i + 1;
      let contentLine = "";
      let contentCount = 0;
      let closeLineIdx = -1;
      let tooComplex = false;
      while (j < lines.length) {
        const nextTrimmed = lines[j].trim();
        // Skip blank lines
        if (nextTrimmed === "") {
          j++;
          continue;
        }
        // Check if this is the close tag on its own line
        if (closePattern.test(nextTrimmed)) {
          closeLineIdx = j;
          break;
        }
        // Check if this line has content + close tag (e.g. "Cancel </a>")
        if (closeInline.test(nextTrimmed)) {
          const contentPart = nextTrimmed.replace(closeInline, "").trim();
          if (contentPart !== "") {
            contentCount++;
            contentLine = contentPart;
          }
          closeLineIdx = j;
          break;
        }
        // This is a content line
        contentCount++;
        if (contentCount > 1) {
          tooComplex = true;
          break;
        }
        // Check content isn't complex
        if (isComplexContent(nextTrimmed)) {
          tooComplex = true;
          break;
        }
        contentLine = nextTrimmed;
        j++;
      }
      // Collapse if conditions met
      if (
        !tooComplex &&
        closeLineIdx !== -1 &&
        contentCount <= 1 &&
        contentLine.length < 60
      ) {
        const leadingWs = lines[i].match(/^(\s*)/)?.[1] || "";
        const collapsed = `${trimmed}${contentLine}</${tagName}>`;
        // Only collapse if result isn't too long
        if (collapsed.length <= printWidth) {
          result.push(leadingWs + collapsed);
          i = closeLineIdx + 1;
          continue;
        }
      }
    }
    result.push(lines[i]);
    i++;
  }
  return result;
}
/**
 * Check if content is too complex to collapse into a single line.
 * Complex = contains HTML tags or Edge block directives.
 * Edge expressions {{ }} are OK.
 */
function isComplexContent(content: string): boolean {
  // Contains HTML tags
  if (/<[a-zA-Z]/.test(content) || /<\//.test(content)) return true;
  // Contains Edge block directives
  if (
    /^@(component|slot|if|each|unless|forelse|section|else|elseif|end|endsection)\b/.test(
      content,
    )
  )
    return true;
  // Contains @include or other directives (these need their own lines)
  if (/^@(include|set|inject)\b/.test(content)) return true;
  return false;
}
// ─── HTML indent delta computation ───────────────────────────────────────────
/**
 * Finds the position AFTER the real closing `>` of an HTML tag,
 * starting from position `start` which should be at `<`.
 * Respects quotes and Edge expressions to avoid false matches
 * on `>` inside attribute values (e.g. arrow functions, comparisons).
 *
 * Returns the index after `>`, or -1 if the tag is never closed on this line.
 */
function findRealTagEnd(str: string, start: number): number {
  let inSingle = false;
  let inDouble = false;
  let inExpr = 0;
  for (let i = start + 1; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1] || "";
    // Track Edge expressions {{ }}
    if (!inSingle && !inDouble) {
      if (ch === "{" && next === "{") {
        inExpr++;
        i++;
        continue;
      }
      if (ch === "}" && next === "}" && inExpr > 0) {
        inExpr--;
        i++;
        continue;
      }
    }
    if (inExpr > 0) continue;
    // Track quotes
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle || inDouble) continue;
    // Found the real closing >
    if (ch === ">") {
      return i + 1;
    }
  }
  return -1;
}
/**
 * Computes the indent delta caused by ALL HTML tags on a single line.
 *
 * Walks through the line character-by-character, tracking quotes and
 * Edge expressions, and counts every opening and closing HTML tag.
 *
 * Uses a stack to distinguish:
 * - Tags closed from PREVIOUS lines → preCloses (decrease indent before print)
 * - Tags opened and closed on THIS same line → no net effect
 * - Tags opened but unclosed on this line → postOpens (increase indent after print)
 *
 * Examples:
 *   "</div>"                                          → { preCloses: 1, postOpens: 0 }
 *   "<div class='a'>"                                 → { preCloses: 0, postOpens: 1 }
 *   "<div>text</div>"                                 → { preCloses: 0, postOpens: 0 }
 *   "</div></div></div>"                              → { preCloses: 3, postOpens: 0 }
 *   "<div class='a'><div class='b'><i></i></div>"     → { preCloses: 0, postOpens: 1 }
 *   "</div><div>"                                     → { preCloses: 1, postOpens: 1 }
 */
function computeIndentDelta(trimmed: string): {
  preCloses: number;
  postOpens: number;
} {
  const tagStack = [];
  let preCloses = 0;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inExpr = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    const next = trimmed[i + 1] || "";
    // Track Edge expressions {{ }} and {{{ }}}
    if (!inSingle && !inDouble) {
      if (ch === "{" && next === "{") {
        inExpr++;
        i += 2;
        continue;
      }
      if (ch === "}" && next === "}" && inExpr > 0) {
        inExpr--;
        i += 2;
        continue;
      }
    }
    // Inside expression, skip
    if (inExpr > 0) {
      i++;
      continue;
    }
    // Track quotes (outside expressions)
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    // Inside quotes, skip
    if (inSingle || inDouble) {
      i++;
      continue;
    }
    // Detect HTML tags
    if (ch === "<") {
      // HTML comment <!-- -->, <!DOCTYPE>, or <?...?> — skip
      if (next === "!" || next === "?") {
        i++;
        continue;
      }
      if (next === "/") {
        // Closing tag: </tagName>
        const closeMatch = trimmed
          .substring(i)
          .match(/^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/);
        if (closeMatch) {
          const tagName = closeMatch[1].toLowerCase();
          // Check if it closes a tag opened on THIS line
          if (
            tagStack.length > 0 &&
            tagStack[tagStack.length - 1] === tagName
          ) {
            tagStack.pop();
          } else {
            // Closes a tag from a PREVIOUS line
            preCloses++;
          }
          i += closeMatch[0].length;
          continue;
        }
      } else if (next && /[a-zA-Z]/.test(next)) {
        // Opening tag: <tagName
        const openMatch = trimmed
          .substring(i)
          .match(/^<([a-zA-Z][a-zA-Z0-9-]*)\b/);
        if (openMatch) {
          const tagName = openMatch[1].toLowerCase();
          // Void elements — skip past the tag, no indent change
          if (HTML_VOID_ELEMENTS.has(tagName)) {
            const voidEnd = findRealTagEnd(trimmed, i);
            i = voidEnd === -1 ? trimmed.length : voidEnd;
            continue;
          }
          // Find the real end of this tag
          const tagEndIdx = findRealTagEnd(trimmed, i);
          if (tagEndIdx === -1) {
            // Tag not closed on this line (incomplete/multi-line tag)
            // Still counts as an opening tag
            tagStack.push(tagName);
            i = trimmed.length;
            continue;
          }
          // Check for self-closing: look for / before > (with possible spaces)
          let isSelfClosing = false;
          for (let k = tagEndIdx - 2; k > i; k--) {
            const c = trimmed[k];
            if (c === "/") {
              isSelfClosing = true;
              break;
            }
            if (c !== " " && c !== "\t") break;
          }
          if (!isSelfClosing) {
            tagStack.push(tagName);
          }
          i = tagEndIdx;
          continue;
        }
      }
    }
    i++;
  }
  return { preCloses, postOpens: tagStack.length };
}
// ─── MAIN FORMATTER ──────────────────────────────────────────────────────────
export class EdgeDocumentFormatter
  implements vscode.DocumentFormattingEditProvider
{
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.TextEdit[]> {
    const enable = vscode.workspace
      .getConfiguration("edge.format")
      .get<boolean>("enable", true);
    if (!enable) {
      return [];
    }
    const config = getConfig();
    const indentStr = options.insertSpaces
      ? " ".repeat(config.indentSize)
      : "\t";
    let lines = document.getText().split("\n");
    // Step 1: Fix broken HTML tags split across lines (e.g. </span\n>)
    lines = fixBrokenHtmlTags(lines);
    // Step 2: Split inline Edge directives to their own lines
    lines = splitInlineDirectives(lines);
    // Step 3: Join multi-line HTML attributes into single lines
    lines = joinMultiLineAttributes(lines);
    // Step 4: Convert simple @if/@else/@end to ternary expressions
    lines = convertSimpleIfElseToTernary(lines);
    // Step 5: Optionally collapse short HTML blocks (off by default)
    if (config.collapseShortBlocks) {
      lines = collapseShortHtmlBlocks(lines, config.printWidth || 140);
    }
    // Step 6: Apply indentation formatting
    let formatted = this.formatLines(lines, indentStr, config);
    // Step 7: Wrap HTML attrs like blade-formatter (after indent so levels stay correct)
    formatted = wrapLongHtmlTags(
      formatted,
      config.printWidth || 140,
      config.indentSize,
      config.wrapAttributes,
      config.wrapAttributesMinAttrs,
    );
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    );
    return [vscode.TextEdit.replace(fullRange, formatted.join("\n"))];
  }
  formatLines(
    lines: string[],
    indentStr: string,
    config: EdgeFormatConfig,
  ): string[] {
    const result = [];
    let indentLevel = 0;
    let insideScriptOrStyle: false | "script" | "style" = false;
    let scriptStyleIndent = 0;
    let innerIndentLevel = 0;
    let consecutiveBlankLines = 0;
    let insideMultiLineComment = false;
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();
      // Handle blank lines
      if (trimmed === "") {
        if (config.preserveNewLines) {
          consecutiveBlankLines++;
          if (consecutiveBlankLines <= config.maxPreserveNewLines) {
            result.push("");
          }
        }
        continue;
      }
      consecutiveBlankLines = 0;
      // Handle multi-line Edge comments {{-- ... --}}
      if (insideMultiLineComment) {
        result.push(indentStr.repeat(indentLevel) + trimmed);
        if (trimmed.includes("--}}")) {
          insideMultiLineComment = false;
        }
        continue;
      }
      if (trimmed.includes("{{--") && !trimmed.includes("--}}")) {
        insideMultiLineComment = true;
        result.push(indentStr.repeat(indentLevel) + trimmed);
        continue;
      }
      // Inside <script> or <style> blocks - re-indent their contents
      if (insideScriptOrStyle) {
        if (SCRIPT_STYLE_CLOSE.test(trimmed)) {
          insideScriptOrStyle = false;
          innerIndentLevel = 0;
          result.push(indentStr.repeat(scriptStyleIndent) + trimmed);
        } else if (insideScriptOrStyle === "style") {
          // Format CSS: track { and } braces
          const baseIndent = scriptStyleIndent + 1;
          if (CSS_CLOSE_BRACE.test(trimmed)) {
            innerIndentLevel = Math.max(0, innerIndentLevel - 1);
            result.push(
              indentStr.repeat(baseIndent + innerIndentLevel) + trimmed,
            );
          } else if (CSS_OPEN_BRACE.test(trimmed)) {
            result.push(
              indentStr.repeat(baseIndent + innerIndentLevel) + trimmed,
            );
            innerIndentLevel++;
          } else {
            result.push(
              indentStr.repeat(baseIndent + innerIndentLevel) + trimmed,
            );
          }
        } else {
          // Script: re-indent based on JS braces
          const baseIndent = scriptStyleIndent + 1;
          const hasClose = /^\s*[\}\]\)]/.test(trimmed);
          if (hasClose) {
            innerIndentLevel = Math.max(0, innerIndentLevel - 1);
          }
          result.push(
            indentStr.repeat(baseIndent + innerIndentLevel) + trimmed,
          );
          const hasOpen = /[\{\[\(]\s*$/.test(trimmed);
          if (hasOpen) {
            innerIndentLevel++;
          }
        }
        continue;
      }
      // Check for script/style opening
      const scriptStyleTag = isScriptStyleOpen(trimmed);
      if (scriptStyleTag) {
        insideScriptOrStyle = scriptStyleTag;
        scriptStyleIndent = indentLevel;
        innerIndentLevel = 0;
        result.push(indentStr.repeat(indentLevel) + trimmed);
        continue;
      }
      // --- Edge directive handling ---
      // @end / @endsection - decrease before printing
      if (EDGE_BLOCK_CLOSE.test(trimmed)) {
        indentLevel = Math.max(0, indentLevel - 1);
        result.push(indentStr.repeat(indentLevel) + trimmed);
        continue;
      }
      // @else / @elseif - decrease before, increase after
      if (EDGE_MID_BLOCK.test(trimmed)) {
        const dedented = Math.max(0, indentLevel - 1);
        result.push(indentStr.repeat(dedented) + trimmed);
        continue;
      }
      // @component, @slot, @if, @each, @unless, @forelse, @section - print then increase
      if (EDGE_BLOCK_OPEN.test(trimmed)) {
        result.push(indentStr.repeat(indentLevel) + trimmed);
        indentLevel++;
        continue;
      }
      // Inline Edge directives (@include, @set, @inject, @break, @continue)
      if (EDGE_INLINE.test(trimmed)) {
        result.push(indentStr.repeat(indentLevel) + trimmed);
        continue;
      }
      // Edge comment (single line)
      if (trimmed.startsWith("{{--")) {
        result.push(indentStr.repeat(indentLevel) + trimmed);
        continue;
      }
      // --- HTML handling (multi-tag aware) ---
      // Compute indent delta from ALL HTML tags on the line.
      // This correctly handles lines with multiple tags like:
      //   <div class="a"><div class="b"><i></i></div>  → net +1
      //   </div></div></div>                           → net -3
      const { preCloses, postOpens } = computeIndentDelta(trimmed);
      if (preCloses > 0 || postOpens > 0) {
        indentLevel = Math.max(0, indentLevel - preCloses);
        result.push(indentStr.repeat(indentLevel) + trimmed);
        indentLevel += postOpens;
        continue;
      }
      // Default: apply current indentation
      result.push(indentStr.repeat(indentLevel) + trimmed);
    }
    // Clean trailing empty lines
    while (result.length > 0 && result[result.length - 1].trim() === "") {
      result.pop();
    }
    // Ensure file ends with newline
    result.push("");
    return result;
  }
}
export class EdgeRangeFormatter
  implements vscode.DocumentRangeFormattingEditProvider
{
  private readonly fullFormatter = new EdgeDocumentFormatter();

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    _range: vscode.Range,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.TextEdit[]> {
    return this.fullFormatter.provideDocumentFormattingEdits(
      document,
      options,
      token,
    );
  }
}

const EDGE_FORMAT_SELECTORS: vscode.DocumentSelector = [
  { language: "edge", scheme: "file" },
  { language: "edge", scheme: "untitled" },
  { pattern: "**/*.edge", scheme: "file" },
];

/**
 * Register Edge document/range/on-type formatters, HTML→Edge comment conversion,
 * and optional convert-on-save.
 */
export function registerEdgeFormatter(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      EDGE_FORMAT_SELECTORS,
      new EdgeDocumentFormatter(),
    ),
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      EDGE_FORMAT_SELECTORS,
      new EdgeRangeFormatter(),
    ),
    vscode.languages.registerOnTypeFormattingEditProvider(
      EDGE_FORMAT_SELECTORS,
      {
        provideOnTypeFormattingEdits(document, position, _ch, options) {
          const line = document.lineAt(position.line);
          const trimmed = line.text.trim();
          if (!/^@(end|endsection)\b/.test(trimmed)) {
            return [];
          }

          let depth = 0;
          let targetIndent = 0;
          const blockOpenPattern =
            /^\s*@(component|slot|if|each|unless|forelse|section|stack|push|prepend)\b/;
          const blockClosePattern =
            /^\s*@(end|endsection|endstack|endpush|endprepend)\b/;

          for (let i = position.line - 1; i >= 0; i--) {
            const prevLine = document.lineAt(i).text;
            if (blockClosePattern.test(prevLine)) {
              depth++;
            } else if (blockOpenPattern.test(prevLine)) {
              if (depth === 0) {
                const match = prevLine.match(/^(\s*)/);
                targetIndent = match ? match[1].length : 0;
                break;
              }
              depth--;
            }
          }

          const indentStr = options.insertSpaces
            ? " ".repeat(targetIndent)
            : "\t".repeat(
                Math.floor(targetIndent / Math.max(options.tabSize, 1)),
              );
          const newText = indentStr + trimmed;
          if (newText === line.text) {
            return [];
          }
          return [vscode.TextEdit.replace(line.range, newText)];
        },
      },
      "d",
      "n",
    ),
    vscode.commands.registerCommand("edge.convertHtmlCommentsToEdge", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "edge") {
        vscode.window.showWarningMessage(
          "This command only works in .edge files.",
        );
        return;
      }

      const edits = buildHtmlCommentConversionEdits(editor.document);
      if (edits.length === 0) {
        vscode.window.showInformationMessage(
          "No HTML comments found to convert.",
        );
        return;
      }

      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.set(editor.document.uri, edits);
      void vscode.workspace.applyEdit(workspaceEdit).then((success) => {
        if (success) {
          vscode.window.showInformationMessage(
            `Converted ${edits.length} HTML comment${edits.length > 1 ? "s" : ""} to Edge comments.`,
          );
        }
      });
    }),
    vscode.workspace.onWillSaveTextDocument((event) => {
      if (event.document.languageId !== "edge") {
        return;
      }
      const config = vscode.workspace.getConfiguration("edge.format");
      if (!config.get<boolean>("convertHtmlCommentsOnSave", false)) {
        return;
      }
      const edits = buildHtmlCommentConversionEdits(event.document);
      if (edits.length > 0) {
        event.waitUntil(Promise.resolve(edits));
      }
    }),
  );
}

function buildHtmlCommentConversionEdits(
  document: vscode.TextDocument,
): vscode.TextEdit[] {
  const fullText = document.getText();
  const htmlCommentRegex = /<!--([\s\S]*?)-->/g;
  const edits: vscode.TextEdit[] = [];
  let match: RegExpExecArray | null;

  while ((match = htmlCommentRegex.exec(fullText)) !== null) {
    const startPos = document.positionAt(match.index);
    const endPos = document.positionAt(match.index + match[0].length);
    const lineText = document.lineAt(startPos.line).text;
    const beforeMatch = fullText.substring(
      Math.max(0, match.index - 10),
      match.index,
    );
    if (beforeMatch.includes("{{--") || lineText.includes("{{--")) {
      continue;
    }

    const commentBody = match[1];
    if (commentBody.includes("\n")) {
      edits.push(
        vscode.TextEdit.replace(
          new vscode.Range(startPos, endPos),
          "{{--" + commentBody + "--}}",
        ),
      );
    } else {
      edits.push(
        vscode.TextEdit.replace(
          new vscode.Range(startPos, endPos),
          `{{-- ${commentBody.trim()} --}}`,
        ),
      );
    }
  }

  return edits;
}
