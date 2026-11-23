export type PathKind = "public" | "project" | "view";

export interface PathMatch {
  path: string;
  /** Absolute offset of the first character of the path (inside quotes) */
  pathOffset: number;
  kind: PathKind;
}

export interface AbsoluteUrlMatch {
  url: string;
  /** Absolute offset of the first character of the URL (inside quotes) */
  urlOffset: number;
}

/** `@!input` / `@!form.field` short-tag → components/*.edge */
export interface ComponentTagMatch {
  /** Tag name without @!, e.g. `input` or `form.field` */
  tagName: string;
  /** Absolute offset of the tag name (after `@` / `@!`) */
  tagOffset: number;
  tagLength: number;
  /** Absolute filesystem path to the .edge component */
  filePath: string;
}
