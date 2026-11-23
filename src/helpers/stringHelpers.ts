/**
 * String helpers for stub placeholders (Adonis-style snake_case paths).
 */

export function studly(value: string): string {
  return value
    .replace(/[-_\s]+(.)?/g, (_, char: string | undefined) => (char ? char.toUpperCase() : ""))
    .replace(/^(.)/, (char) => char.toUpperCase());
}

export function camel(value: string): string {
  const s = studly(value);
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function snake(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

export function kebab(value: string): string {
  return snake(value).replace(/_/g, "-");
}

/** Simple English pluralization (enough for table names like product_categories). */
export function plural(snakeName: string): string {
  if (snakeName.endsWith("ies") || snakeName.endsWith("es") || snakeName.endsWith("s")) {
    return snakeName;
  }
  if (/[^aeiou]y$/i.test(snakeName)) {
    return `${snakeName.slice(0, -1)}ies`;
  }
  if (/(?:s|x|z|ch|sh)$/i.test(snakeName)) {
    return `${snakeName}es`;
  }
  return `${snakeName}s`;
}
