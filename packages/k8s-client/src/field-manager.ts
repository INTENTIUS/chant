/**
 * chant's field-manager identity — chant #1075.
 *
 * Server-side apply records, per field, the name of the manager that last
 * wrote it. That name is chant's identity in the cluster, so it has to be
 * *stable* (the same stack applying twice must be the same manager, or the
 * second apply conflicts with the first) and *distinguishing* (two chant
 * stacks sharing a cluster must not silently co-own each other's fields).
 *
 * The scheme is `chant` alone, or `chant:<stack>` when the project sets
 * `ownership.stack` — the same identity the label-based ownership marker
 * already carries (`packages/core/src/ownership.ts`). Ownership-by-label
 * answers a binary whole-object question; the field manager is the sub-object
 * version of the same fact, supplied by the API server rather than stamped by
 * chant. One identity, two granularities.
 *
 * **`ownership.env` is deliberately not part of it.** Two environments of one
 * stack only ever touch the same object if they share a namespace and a name,
 * and at that point they are fighting over it. An env-qualified manager would
 * let them each own a different half of that object without either noticing;
 * a stack-qualified one makes the second apply conflict, which is the correct
 * outcome and the whole point of the conflict surface.
 *
 * This module is plain string logic with no dependency on chant core, so the
 * lexicon (which reads `ownership` from project config) and the client (which
 * writes the query parameter) agree on one derivation rather than two.
 */

import { FieldManagerError } from "./errors";

/** The unqualified manager, used when a project sets no ownership stack. */
export const CHANT_FIELD_MANAGER = "chant";

/** Separator between the `chant` prefix and the stack identity. */
export const FIELD_MANAGER_SEPARATOR = ":";

/**
 * The API server's own ceiling on `fieldManager`
 * (`k8s.io/apiserver/pkg/endpoints/handlers/fieldmanager`). Exceeding it is a
 * 400 on every apply, so it is checked here — where the name is derived and
 * the offending config key can be named — rather than discovered in a cluster.
 */
export const FIELD_MANAGER_MAX_LENGTH = 128;

/** The stack identity a field manager is derived from. */
export interface FieldManagerIdentity {
  /** `ownership.stack` from project config, when set. */
  stack?: string;
}

/**
 * Derive the field manager for a stack. `undefined`/no stack yields the bare
 * `chant`; a stack yields `chant:<stack>`.
 */
export function fieldManagerFor(identity?: FieldManagerIdentity): string {
  const stack = identity?.stack?.trim();
  if (!stack) return CHANT_FIELD_MANAGER;
  const manager = `${CHANT_FIELD_MANAGER}${FIELD_MANAGER_SEPARATOR}${stack}`;
  assertValidFieldManager(manager, stack);
  return manager;
}

/**
 * Reject a field manager the API server would reject, naming the config key
 * responsible. A silent truncation would be worse than a failure: it would
 * merge two stacks' identities into one and make their applies fight.
 */
export function assertValidFieldManager(manager: string, stack?: string): void {
  const source = stack === undefined ? `field manager "${manager}"` : `ownership.stack "${stack}"`;
  if (manager.length === 0) {
    throw new FieldManagerError(`${source} produces an empty field manager, which the API server rejects`);
  }
  if (manager.length > FIELD_MANAGER_MAX_LENGTH) {
    throw new FieldManagerError(
      `${source} produces the field manager "${manager}" (${manager.length} characters), ` +
        `over the API server's ${FIELD_MANAGER_MAX_LENGTH}-character limit`,
    );
  }
  // Space (0x20), every C0 control, and DEL. A code-point scan rather than a
  // regexp, so no literal control character ever appears in this source.
  const badIndex = [...manager].findIndex((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f;
  });
  if (badIndex !== -1) {
    throw new FieldManagerError(
      `${source} produces the field manager "${manager}", which contains whitespace or a control ` +
        `character at position ${badIndex}. A field manager is an identity recorded on every object ` +
        `chant applies; keep it to printable, space-free text.`,
    );
  }
}

/** True when `manager` is a chant field manager, qualified or not. */
export function isChantFieldManager(manager: string | undefined): boolean {
  if (!manager) return false;
  return (
    manager === CHANT_FIELD_MANAGER ||
    manager.startsWith(`${CHANT_FIELD_MANAGER}${FIELD_MANAGER_SEPARATOR}`)
  );
}

/**
 * The stack a chant field manager names, or undefined for the unqualified
 * `chant` and for any manager that is not chant's at all.
 */
export function chantStackOf(manager: string | undefined): string | undefined {
  if (!manager || !isChantFieldManager(manager)) return undefined;
  const stack = manager.slice(CHANT_FIELD_MANAGER.length + FIELD_MANAGER_SEPARATOR.length);
  return stack.length > 0 ? stack : undefined;
}
