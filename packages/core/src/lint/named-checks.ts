import type * as ts from "typescript";
import type { LintContext } from "./rule";

/**
 * A named check function that evaluates a condition on a node.
 */
export type NamedCheckFn = (node: ts.Node, context: LintContext) => boolean;

/**
 * Registry of named check functions.
 */
const checkRegistry = new Map<string, NamedCheckFn>();

/**
 * Register a named check function.
 */
export function registerCheck(name: string, fn: NamedCheckFn): void {
  checkRegistry.set(name, fn);
}

/**
 * Get a named check by name. Returns undefined if not found.
 */
export function getNamedCheck(name: string): NamedCheckFn | undefined {
  return checkRegistry.get(name);
}

/**
 * List all registered check names.
 */
export function listChecks(): string[] {
  return Array.from(checkRegistry.keys());
}
