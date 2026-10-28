/**
 * The JSON replacer that sorts object keys, alone in a leaf module so a small
 * bundle that digests JSON (the gate decision's gated-request digest, #4551)
 * takes it without `./utils.ts` and its AttrRef import.
 */

/**
 * JSON.stringify replacer that sorts object keys for deterministic output.
 */
export function sortedJsonReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return value;
}
