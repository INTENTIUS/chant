/**
 * The top-level keys of a Kubernetes object that its kind does not declare
 * (#5111), shared by `chant import` (./import/typed-classes.ts) and the
 * WK8506 post-synth check (./lint/post-synth/wk8506.ts).
 *
 * `kubectl apply` of such a key fails by default (`strict decoding error:
 * unknown field "labels"`), and with `--validate=ignore` the API server drops
 * it, so a key beside `metadata` that was meant to sit under it never takes
 * effect. No Node imports: the post-synth barrel reaches this and must stay
 * edge-safe.
 */

/**
 * The keys of `doc` that are not in `declared`, in document order. An empty
 * list when `declared` is unknown, so a kind without a schema is left alone.
 */
export function unknownTopLevelKeys(doc: Record<string, unknown>, declared: readonly string[] | undefined): string[] {
  if (!declared) return [];
  const known = new Set(declared);
  return Object.keys(doc).filter((key) => !known.has(key));
}

/** Whether the object's `metadata` has a field called `key` (a misplaced `labels` beside `metadata`). */
export function metadataHasKey(doc: Record<string, unknown>, key: string): boolean {
  const metadata = doc.metadata;
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) && key in metadata;
}

/**
 * The sentence both the import warning and the build finding use for one
 * unknown key: what the key is, what `kubectl apply` does with it, and, when
 * `metadata` has a field of that name, where it probably belongs.
 */
export function unknownKeyReason(kind: string, key: string, alsoInMetadata: boolean): string {
  return (
    `the top-level key "${key}" is not a field of ${kind}; kubectl apply rejects it, and with validation off the API server drops it` +
    (alsoInMetadata ? `. metadata has a field named "${key}", so it may belong there` : "")
  );
}
