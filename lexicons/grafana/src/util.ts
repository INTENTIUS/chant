/** Small helpers shared by the entity modules and the builder. */

/** Every field optional, all the way down; arrays keep their element type partial too. */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Grafana's uid alphabet: letters, digits, `-` and `_`, at most 40 characters. */
export const UID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function isValidUid(uid: string): boolean {
  return UID_PATTERN.test(uid);
}

/**
 * A uid from free text (an export name or a datasource name): camelCase and
 * spaces become `-`, anything outside the uid alphabet is dropped, and the
 * result is cut to 40 characters.
 */
export function slugUid(text: string): string {
  const slug = text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return slug.slice(0, 40).replace(/-$/, "") || "dashboard";
}

/** Copy `value` with every `undefined` property dropped, recursively; keeps key order. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => compact(v)) as unknown as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = compact(v);
    }
    return out as T;
  }
  return value;
}
