import * as fs from "fs";
import * as path from "path";
import { BUILTIN_EDGE_TAGS } from "../helpers/builtinEdgeTags";
import { buildComponentTagMap } from "../helpers/edgeComponentDiscovery";
import { getViewDisks } from "../helpers/viewDisks";
import type { EdgeGlobalBinding } from "../interfaces/edgeGlobal";
import type {
  AbsoluteUrlMatch,
  ComponentTagMatch,
  PathKind,
  PathMatch,
} from "../interfaces/edgePathNavigation";
import { discoverEdgeGlobals } from "./edgeGlobalDiscovery";

/** `@!input` / `@input` / `@!form.field` / `@!uikit.input` */
const CUSTOM_COMPONENT_TAG_PATTERN = /@(!?)([a-zA-Z][\w.]*)\b/g;

/**
 * Path helpers and absolute http(s) URL navigation for Edge templates.
 *
 * editor.links is disabled for [edge] so built-in relative href/src
 * underlines (including src="{{ ... }}") are suppressed. Instead:
 * - Decorations: always-visible underline for publicAsset / @vite / @include /
 *   @component / custom short tags (@!input) / edge.global helpers /
 *   absolute http(s)
 * - DefinitionProvider: Ctrl/Cmd+Click + F12 for local files
 * - HoverProvider: absolute http(s) to Open URL command
 */
export class EdgePathNavigator {
  /** publicAsset( — args collected like @vite for nested/quoted paths */
  private static readonly PUBLIC_HELPER_CALL_PATTERN = /\bpublicAsset\s*\(/g;

  private static readonly VITE_CALL_PATTERN = /@vite\s*\(/g;

  /** @include('...') / @component('...') / @!component('...') */
  private static readonly VIEW_DIRECTIVE_PATTERN =
    /@!?component\s*\(|@include\s*\(/g;

  /** href / src / action / formaction / poster / data-src / data-href */
  private static readonly HTML_URL_ATTR_PATTERN =
    /\b(?:href|src|action|formaction|poster|data-src|data-href)\s*=\s*(['"])([^'"]*)\1/gi;

  private static readonly ABSOLUTE_URL_PATTERN = /^https?:\/\//i;

  /** tagName → file cache (Edge-style discovery), short TTL for edit/watch cycles */
  private componentTagCache = new Map<
    string,
    { tags: Map<string, string>; expires: number }
  >();

  /** edge.global name → helper module cache */
  private edgeGlobalCache = new Map<
    string,
    { globals: Map<string, EdgeGlobalBinding>; expires: number }
  >();

  findHelperPaths(text: string): PathMatch[] {
    return [
      ...this.findPublicHelperPaths(text),
      ...this.findVitePaths(text),
      ...this.findViewDirectivePaths(text),
    ];
  }

  /**
   * Custom component short tags: `@!input`, `@!form.field`, `@!uikit.input`.
   * Only returns tags that resolve to an existing file under components/.
   */
  findCustomComponentTags(
    text: string,
    projectRoot: string,
  ): ComponentTagMatch[] {
    const matches: ComponentTagMatch[] = [];
    const pattern = new RegExp(
      CUSTOM_COMPONENT_TAG_PATTERN.source,
      CUSTOM_COMPONENT_TAG_PATTERN.flags,
    );

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const bang = match[1];
      const tagName = match[2];
      const base = tagName.split(".")[0].toLowerCase();

      if (BUILTIN_EDGE_TAGS.has(base)) {
        continue;
      }

      const filePath = this.resolveComponentTagFile(projectRoot, tagName);
      if (!filePath) {
        continue;
      }

      // Underline the tag name only (`input` in `@!input`), not `@!`
      const tagOffset = match.index + 1 + bang.length;
      matches.push({
        tagName,
        tagOffset,
        tagLength: tagName.length,
        filePath,
      });
    }

    return matches;
  }

  /**
   * Resolve a short-tag name the same way Edge registers components:
   * scan components/*.edge recursively, convert file path to camelCase tag, look up.
   * `input_password.edge` → `@!inputPassword`
   * `checkout_form/input.edge` → `@!checkoutForm.input`
   * `uikit` disk `input.edge` → `@!uikit.input`
   */
  resolveComponentTagFile(
    projectRoot: string,
    tagName: string,
  ): string | null {
    const trimmed = tagName.trim();
    if (!trimmed) {
      return null;
    }

    const tags = this.getComponentTagMap(projectRoot);
    const exact = tags.get(trimmed);
    if (exact && fs.existsSync(exact)) {
      return exact;
    }

    // Case-insensitive fallback (users sometimes type @!InputPassword)
    const lower = trimmed.toLowerCase();
    for (const [tag, filePath] of tags) {
      if (tag.toLowerCase() === lower && fs.existsSync(filePath)) {
        return filePath;
      }
    }

    return null;
  }

  private getComponentTagMap(projectRoot: string): Map<string, string> {
    const cached = this.componentTagCache.get(projectRoot);
    if (cached && cached.expires > Date.now()) {
      return cached.tags;
    }

    const tags = buildComponentTagMap(projectRoot, getViewDisks());
    this.componentTagCache.set(projectRoot, {
      tags,
      expires: Date.now() + 1500,
    });
    return tags;
  }

  getEdgeGlobals(projectRoot: string): Map<string, EdgeGlobalBinding> {
    const cached = this.edgeGlobalCache.get(projectRoot);
    if (cached && cached.expires > Date.now()) {
      return cached.globals;
    }

    const globals = discoverEdgeGlobals(projectRoot);
    this.edgeGlobalCache.set(projectRoot, {
      globals,
      expires: Date.now() + 2000,
    });
    return globals;
  }

  findAbsoluteHtmlUrls(text: string): AbsoluteUrlMatch[] {
    const matches: AbsoluteUrlMatch[] = [];
    const pattern = new RegExp(
      EdgePathNavigator.HTML_URL_ATTR_PATTERN.source,
      EdgePathNavigator.HTML_URL_ATTR_PATTERN.flags,
    );

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[2];
      // Skip Edge expressions / non-http values (e.g. src="{{ auth.user.profileFileUrl }}")
      if (
        url.includes("{{") ||
        !EdgePathNavigator.ABSOLUTE_URL_PATTERN.test(url)
      ) {
        continue;
      }
      const quote = match[1];
      const urlOffset =
        match.index + match[0].indexOf(quote + url + quote) + 1;
      matches.push({ url, urlOffset });
    }

    return matches;
  }

  resolveFile(
    projectRoot: string,
    assetPath: string,
    kind: PathKind,
  ): string | null {
    if (kind === "view") {
      return this.resolveViewFile(projectRoot, assetPath);
    }

    const relative = assetPath.replace(/^\/+/, "");
    if (!relative) {
      return null;
    }

    return kind === "public"
      ? path.join(projectRoot, "public", relative)
      : path.join(projectRoot, relative);
  }

  /**
   * `dashboard/partials/sidebar` → resources/views/dashboard/partials/sidebar.edge
   * `docs::guide/intro` → disk "docs" path + guide/intro.edge
   */
  private resolveViewFile(
    projectRoot: string,
    templatePath: string,
  ): string | null {
    const trimmed = templatePath.trim();
    if (!trimmed) {
      return null;
    }

    const disks = getViewDisks();
    let diskName = "default";
    let viewPath = trimmed;

    const diskSep = trimmed.indexOf("::");
    if (diskSep !== -1) {
      diskName = trimmed.slice(0, diskSep) || "default";
      viewPath = trimmed.slice(diskSep + 2);
    }

    const diskRoot = disks[diskName] ?? disks.default;
    if (!diskRoot || !viewPath) {
      return null;
    }

    const withExt = viewPath.toLowerCase().endsWith(".edge")
      ? viewPath
      : `${viewPath}.edge`;

    return path.join(projectRoot, diskRoot, withExt.replace(/^\/+/, ""));
  }

  /**
   * Paths inside publicAsset(...) — same extraction style as @vite so
   * Ctrl/Cmd+hover works consistently inside `{{ publicAsset('…') }}`.
   */
  private findPublicHelperPaths(text: string): PathMatch[] {
    const matches: PathMatch[] = [];
    const callPattern = new RegExp(
      EdgePathNavigator.PUBLIC_HELPER_CALL_PATTERN.source,
      EdgePathNavigator.PUBLIC_HELPER_CALL_PATTERN.flags,
    );

    let call: RegExpExecArray | null;
    while ((call = callPattern.exec(text)) !== null) {
      const argsStart = call.index + call[0].length;
      const argsEnd = this.findMatchingParen(text, argsStart - 1);
      if (argsEnd === -1) {
        continue;
      }

      const args = text.slice(argsStart, argsEnd);
      const stringPattern = /(['"])([^'"]+)\1/g;
      let strMatch: RegExpExecArray | null;
      while ((strMatch = stringPattern.exec(args)) !== null) {
        const assetPath = strMatch[2];
        if (!assetPath.trim()) {
          continue;
        }
        matches.push({
          path: assetPath,
          pathOffset: argsStart + strMatch.index + 1,
          kind: "public",
        });
        // publicAsset takes a single path argument
        break;
      }
    }

    return matches;
  }

  /**
   * Collects every quoted path inside @vite(...) — supports a single string
   * or an array of strings.
   */
  private findVitePaths(text: string): PathMatch[] {
    const matches: PathMatch[] = [];
    const callPattern = new RegExp(
      EdgePathNavigator.VITE_CALL_PATTERN.source,
      EdgePathNavigator.VITE_CALL_PATTERN.flags,
    );

    let call: RegExpExecArray | null;
    while ((call = callPattern.exec(text)) !== null) {
      const argsStart = call.index + call[0].length;
      const argsEnd = this.findMatchingParen(text, argsStart - 1);
      if (argsEnd === -1) {
        continue;
      }

      const args = text.slice(argsStart, argsEnd);
      const stringPattern = /(['"])([^'"]+)\1/g;
      let strMatch: RegExpExecArray | null;
      while ((strMatch = stringPattern.exec(args)) !== null) {
        const vitePath = strMatch[2];
        if (!vitePath.trim()) {
          continue;
        }
        matches.push({
          path: vitePath,
          pathOffset: argsStart + strMatch.index + 1,
          kind: "project",
        });
      }
    }

    return matches;
  }

  /**
   * First quoted template path inside @include(...) / @component(...) /
   * @!component(...).
   */
  private findViewDirectivePaths(text: string): PathMatch[] {
    const matches: PathMatch[] = [];
    const callPattern = new RegExp(
      EdgePathNavigator.VIEW_DIRECTIVE_PATTERN.source,
      EdgePathNavigator.VIEW_DIRECTIVE_PATTERN.flags,
    );

    let call: RegExpExecArray | null;
    while ((call = callPattern.exec(text)) !== null) {
      const argsStart = call.index + call[0].length;
      const argsEnd = this.findMatchingParen(text, argsStart - 1);
      if (argsEnd === -1) {
        continue;
      }

      const args = text.slice(argsStart, argsEnd);
      const firstString = /^\s*(['"])([^'"]+)\1/.exec(args);
      if (!firstString) {
        continue;
      }

      const viewPath = firstString[2];
      if (!viewPath.trim()) {
        continue;
      }

      matches.push({
        path: viewPath,
        pathOffset: argsStart + firstString.index + firstString[0].indexOf(viewPath),
        kind: "view",
      });
    }

    return matches;
  }

  /** Index of `(` is openIdx; returns index of matching `)` or -1. */
  private findMatchingParen(text: string, openIdx: number): number {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;

    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (inSingle || inDouble) {
        continue;
      }
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }

    return -1;
  }
}
