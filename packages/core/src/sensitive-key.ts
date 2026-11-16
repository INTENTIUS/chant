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


/**
 * Reference fields: keys that match {@link SENSITIVE_KEY_PATTERNS} only because
 * the word "secret" is in the name, and whose value names another object
 * instead of holding a secret. `spec.secretStoreRef` on an ExternalSecret is
 * `{ name, kind }`, the pointer to a SecretStore; a joined graph needs it.
 *
 * This is an exact-key allowlist, and the value must also have the shape of a
 * pointer (see {@link isReferenceField}). A key outside the list stays masked
 * by the patterns, so a new field is masked until someone adds it here.
 * `secretKeyRef` is not on the list: its `key` names an entry inside a Secret
 * and the paths that read a masked value (chant import) treat it as one.
 */
export const REFERENCE_KEYS: ReadonlySet<string> = new Set(["secretStoreRef", "secretRef", "imagePullSecrets"]);

/** The only fields a pointer may carry. `key`, `value`, `data` and the like are not here. */
const REFERENCE_FIELDS: ReadonlySet<string> = new Set(["name", "namespace", "kind", "apiVersion"]);

function isPointer(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([k, v]) => REFERENCE_FIELDS.has(k) && typeof v === "string");
}

/**
 * True when `key` is a reference key and `value` is a pointer to an object:
 * a plain object whose every field is a string named `name`, `namespace`,
 * `kind` or `apiVersion` (or a list of such objects, for `imagePullSecrets`).
 * Anything else under the same key, a string, a number, an object with a
 * `key` or `value` field, a nested object, is not a pointer and stays masked.
 * The value is not a secret, but the check is on shape so that a value that
 * could be one never passes on the strength of its key.
 */
export function isReferenceField(key: string, value: unknown): boolean {
  if (!REFERENCE_KEYS.has(key)) return false;
  if (Array.isArray(value)) return value.length > 0 && value.every(isPointer);
  return isPointer(value);
}

/**
 * Where a Kubernetes pod spec names a Secret (chant#5252), as an index-erased
 * pattern: a Pod's `spec`, a workload's `spec.template.spec`, or a CronJob's
 * `spec.jobTemplate.spec.template.spec`, then one of the four places that
 * name a Secret. Each maps to the field that holds the name.
 */
const POD_SPEC = String.raw`^spec\.(?:(?:jobTemplate\.spec\.)?template\.spec\.)?`;
const CONTAINERS = String.raw`(?:initContainers|containers|ephemeralContainers)\[\]\.`;
const SECRET_NAME_HOLDERS: ReadonlyArray<{ re: RegExp; field: string; list?: true }> = [
  { re: new RegExp(`${POD_SPEC}volumes\\[\\]\\.secret$`), field: "secretName" },
  { re: new RegExp(`${POD_SPEC}volumes\\[\\]\\.projected\\.sources\\[\\]\\.secret$`), field: "name" },
  { re: new RegExp(`${POD_SPEC}${CONTAINERS}env\\[\\]\\.valueFrom\\.secretKeyRef$`), field: "name" },
  { re: new RegExp(`${POD_SPEC}${CONTAINERS}envFrom\\[\\]\\.secretRef$`), field: "name" },
  { re: new RegExp(`${POD_SPEC}imagePullSecrets$`), field: "name", list: true },
];

function nameView(value: unknown, field: string, masked: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const name = obj[field];
  if (typeof name !== "string" || name === "" || name === "<masked>" || name === "[REDACTED]") return undefined;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) out[k] = k === field ? name : masked;
  return out;
}

/**
 * The readable view of a Secret reference in a pod spec (chant#5252), or
 * undefined when `pattern` is not one or `value` names no Secret. The name
 * stays (`volumes[].secret.secretName`, `secretKeyRef.name`,
 * `envFrom[].secretRef.name`, `imagePullSecrets[].name`) and every other
 * field becomes `masked`, so a Secret's key names and options stay hidden
 * as before. Both masking passes call it (the lister's and the deep
 * observation's), on the declared and the live side alike, so the two sides
 * still compare equal. A value that is already `masked` is not a view and
 * gives undefined.
 */
export function podSecretNameView(pattern: string, value: unknown, masked: string): unknown {
  for (const h of SECRET_NAME_HOLDERS) {
    if (!h.re.test(pattern)) continue;
    if (h.list) {
      if (!Array.isArray(value) || value.length === 0) return undefined;
      const views = value.map((v) => nameView(v, h.field, masked));
      return views.every((v) => v !== undefined) ? views : undefined;
    }
    return nameView(value, h.field, masked);
  }
  return undefined;
}
