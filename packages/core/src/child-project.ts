/**
 * Child Project — represents a nested project directory that gets built
 * independently and referenced from a parent as a single deployment unit.
 *
 * Lexicons create ChildProjectInstance via their own factory (e.g. `nestedStack()`).
 * The core build pipeline detects these and recursively builds children.
 */

import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import type { BuildResult } from "./build";

/**
 * Marker symbol for child project identification.
 */
export const CHILD_PROJECT_MARKER = Symbol.for("chant.childProject");

/**
 * A child project instance — a Declarable representing a separately-built
 * project directory referenced from a parent.
 */
export interface ChildProjectInstance extends Declarable {
  readonly [CHILD_PROJECT_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: string;
  readonly entityType: string;
  readonly kind: "resource";
  readonly projectPath: string;
  readonly logicalName: string;
  readonly outputs: Record<string, unknown>;
  readonly options: Record<string, unknown>;
  buildResult?: BuildResult;
}

/**
 * Type guard for ChildProjectInstance.
 */
export function isChildProject(value: unknown): value is ChildProjectInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    CHILD_PROJECT_MARKER in value &&
    (value as Record<symbol, unknown>)[CHILD_PROJECT_MARKER] === true
  );
}
