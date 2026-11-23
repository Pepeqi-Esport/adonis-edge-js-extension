export type StubKind = "api" | "dashboard";

export interface FolderPath {
  /** Snake segments, e.g. ["dashboard", "product"] */
  segments: string[];
  /** Path form: dashboard/product */
  path: string;
  stubKind: StubKind;
}

export interface StubFileDef {
  stubRelative: string;
  targetRelative: string;
}

export interface GenerateResult {
  created: string[];
  skipped: string[];
  errors: string[];
}
