export interface ClickContext {
  type:
    | "controller_variable"
    | "controller_barrel"
    | "method_string"
    | "controller_import_path"
    | "routes_module";
  variableName?: string;
  controllerName?: string;
  methodName?: string;
  importPath?: string;
  moduleName?: string;
  barrelPath?: string[];
  /** Absolute offsets for partial highlight inside magic strings */
  selectionStart?: number;
  selectionEnd?: number;
}

export interface HandlerInfo {
  type: "controller" | "controller_variable" | "controller_barrel";
  controllerName?: string;
  variableName?: string;
  methodName?: string;
  barrelPath?: string[];
}
