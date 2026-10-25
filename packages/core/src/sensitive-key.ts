/**
 * Which property names carry a secret, by name alone.
 *
 * One list for every path that redacts by key: the deep observation's
 * normalization pass (`./deep-observation.ts`), the thin snapshot path's
 * warning (`./lifecycle/snapshot.ts`), and the drift record's second
 * redaction pass (`./drift-record.ts`). This module imports nothing, so the
 * drift record can use it inside the change-set bundle (#3421).
 */

/**
 * Property-name patterns that mark a value secret-bearing. Deliberately narrow
 * and key-name based: broadening this to e.g. `/key/i` would mask an AWS tag's
 * `Key` field and every `*KeyName` reference, which is how masking turns into
 * its own drift signal.
 *
 * Shared with the thin snapshot path (`./lifecycle/snapshot.ts`), which warns
 * on the same names — one list, so the two paths cannot disagree about what
 * counts as a secret.
 */
export const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /private.?key/i,
  /credential/i,
  /connection.?string/i,
];

/** True when a property name looks secret-bearing (see {@link SENSITIVE_KEY_PATTERNS}). */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

