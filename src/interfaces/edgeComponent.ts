export interface EdgeComponentInfo {
  /** Tag name without @!, e.g. `input` or `form.field` */
  tagName: string;
  /** Absolute path to the .edge file */
  filePath: string;
  props: string[];
}
