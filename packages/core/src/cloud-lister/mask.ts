/**
 * behold#1029: secret-bearing values are masked in the lister, before a
 * `ListingResult` exists, so no later stage (chant#4521's typing, the store,
 * LadybugDB) ever holds one (#1025 "Source interface").
 *
 * The key list is chant's `SENSITIVE_KEY_PATTERNS` (../sensitive-key.ts), the
 * one list chant's thin and deep observation paths share. behold carried a
 * copy while the lister lived there; in chant it is the same list.
 *
 * Beyond key names, two things are masked whole because their values are
 * secrets whatever their keys are called:
 *  - a Kubernetes Secret's `data` and `stringData`, and its
 *    `kubectl.kubernetes.io/last-applied-configuration` annotation, which
 *    repeats them;
 *  - any tag or label whose key matches the patterns.
 */

import { isSensitiveKey, SENSITIVE_KEY_PATTERNS } from "../sensitive-key";

export { isSensitiveKey, SENSITIVE_KEY_PATTERNS };

/** What a masked value becomes. A fixed string, so a masked value never diffs. */
export const MASKED = "<masked>";

/**
 * A deep copy of `value` with every value under a sensitive key replaced by
 * {@link MASKED}. Arrays of `{Key, Value}` / `{key, value}` pairs (AWS tags,
 * some ARM shapes) are masked by the pair's key as well.
 */
export function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => maskValue(v));
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const pairKey = typeof obj.Key === "string" ? obj.Key : typeof obj.key === "string" ? obj.key : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      out[k] = MASKED;
    } else if (pairKey !== undefined && isSensitiveKey(pairKey) && (k === "Value" || k === "value")) {
      out[k] = MASKED;
    } else {
      out[k] = maskValue(v);
    }
  }
  return out;
}

export function maskProperties(props: Record<string, unknown>): Record<string, unknown> {
  return maskValue(props) as Record<string, unknown>;
}

export function maskTags(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) out[k] = isSensitiveKey(k) ? MASKED : v;
  return out;
}

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/** A Kubernetes object, masked: key names everywhere, and a Secret's payload whole. */
export function maskKubernetesObject(obj: Record<string, unknown>): Record<string, unknown> {
  const masked = maskProperties(obj);
  if (obj.kind === "Secret") {
    for (const field of ["data", "stringData"]) {
      const payload = masked[field];
      if (payload && typeof payload === "object") {
        masked[field] = Object.fromEntries(Object.keys(payload as object).map((k) => [k, MASKED]));
      }
    }
  }
  const metadata = masked.metadata as Record<string, unknown> | undefined;
  const annotations = metadata?.annotations as Record<string, unknown> | undefined;
  if (annotations && LAST_APPLIED in annotations && obj.kind === "Secret") {
    annotations[LAST_APPLIED] = MASKED;
  }
  return masked;
}
