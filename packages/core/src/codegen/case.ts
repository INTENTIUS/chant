/**
 * Case conversion utilities for codegen.
 */

export function toCamelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export function toPascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
