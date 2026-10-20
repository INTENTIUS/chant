/**
 * What a server-side apply would change in one object (#3998): the live
 * object against the result of a dry-run apply of the declared one.
 *
 * Both sides come from the API server, so a field the server defaults or
 * fills in appears on both with the same value and drops out of the diff.
 * What is left out before comparing is the bookkeeping the server writes on
 * every request and that says nothing about the declared state: managed
 * fields, the resource version, the uid, the creation timestamp, the
 * generation (a dry run of a spec change bumps it) and `status`.
 *
 * Pure functions only, with no client import, so the capability module can
 * share them without reaching the API-client chain (#1074).
 */

/** One field whose value the apply would change. `before` is absent on an added field, `after` on a removed one. */
export interface FieldChange {
  path: string;
  before?: unknown;
  after?: unknown;
}

/** The `metadata` keys the server writes on every request. */
const SERVER_METADATA = ["managedFields", "resourceVersion", "uid", "creationTimestamp", "generation", "selfLink"] as const;

/** A copy of `object` without the fields the server writes on every request. */
export function normalizeServerObject(object: Record<string, unknown>): Record<string, unknown> {
  const { status: _status, ...rest } = object;
  const metadata = rest.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const copy: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };
    for (const key of SERVER_METADATA) delete copy[key];
    rest.metadata = copy;
  }
  return rest;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Deep equality over JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** `spec.replicas`, or `metadata.labels["app.kubernetes.io/name"]` for a key that is not a plain identifier. */
function joinPath(prefix: string, key: string): string {
  if (/^[A-Za-z_$][\w$-]*$/.test(key)) return prefix ? `${prefix}.${key}` : key;
  return `${prefix}[${JSON.stringify(key)}]`;
}

/**
 * The fields that differ between `live` and `next`, both normalized. Objects
 * are walked to their leaves; a list is compared whole and reported at its
 * own path, since a list's items have no stable address in general.
 */
export function diffFields(live: Record<string, unknown>, next: Record<string, unknown>, prefix = ""): FieldChange[] {
  const changes: FieldChange[] = [];
  const keys = [...new Set([...Object.keys(live), ...Object.keys(next)])].sort();
  for (const key of keys) {
    const path = joinPath(prefix, key);
    const hasBefore = Object.prototype.hasOwnProperty.call(live, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(next, key);
    const before = live[key];
    const after = next[key];
    // An object on both sides, or added or removed whole, is walked to its
    // leaves. An empty object added or removed has none, so it stands as itself.
    const walkable = (has: boolean, v: unknown) => !has || isPlainObject(v);
    if ((isPlainObject(before) || isPlainObject(after)) && walkable(hasBefore, before) && walkable(hasAfter, after)) {
      const inner = diffFields(hasBefore ? (before as Record<string, unknown>) : {}, hasAfter ? (after as Record<string, unknown>) : {}, path);
      if (inner.length > 0 || hasBefore === hasAfter) {
        changes.push(...inner);
        continue;
      }
    }
    if (hasBefore && hasAfter && jsonEqual(before, after)) continue;
    changes.push({ path, ...(hasBefore ? { before } : {}), ...(hasAfter ? { after } : {}) });
  }
  return changes;
}
