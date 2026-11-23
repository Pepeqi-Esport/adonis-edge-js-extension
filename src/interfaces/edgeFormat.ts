/** Same modes as shufo/blade-formatter (js-beautify wrap_attributes). */
export type WrapAttributesMode =
  | "auto"
  | "force"
  | "force-aligned"
  | "force-expand-multiline"
  | "aligned-multiple"
  | "preserve"
  | "preserve-aligned";

export interface EdgeFormatConfig {
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
