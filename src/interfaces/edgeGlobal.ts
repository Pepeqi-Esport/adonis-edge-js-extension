export interface EdgeGlobalBinding {
  /** Name registered via edge.global("…") */
  globalName: string;
  /** Absolute path to the helper module (or registration file for locals) */
  filePath: string;
}

export interface EdgeGlobalUsageMatch {
  /** Absolute offset of the underlined span in the Edge document */
  offset: number;
  length: number;
  /** Absolute path to open */
  filePath: string;
  /** Optional method/function name to select in the target file */
  methodName?: string;
}

export interface SourceRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}
