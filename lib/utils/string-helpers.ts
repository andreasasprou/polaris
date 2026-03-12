/**
 * Simple string utility helpers.
 */

/** Truncate a string to maxLen, appending ellipsis if truncated. */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/** Convert a camelCase string to kebab-case. */
export function camelToKebab(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Capitalize the first letter of a string. */
export function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Remove duplicate consecutive whitespace. */
export function collapseWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}
