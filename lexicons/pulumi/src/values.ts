/**
 * Reading property values out of Pulumi's JSON (#4453), shared by the
 * change-set and drift adapters.
 *
 * `pulumi preview --json` and `pulumi refresh --preview-only --json` print
 * each step's `oldState` and `newState` as `apitype.ResourceV3`, whose
 * `inputs` and `outputs` are serialized property maps. Two values in them are
 * not plain JSON:
 *
 * - An unknown, a value known only after apply, is the string
 *   {@link PULUMI_UNKNOWN} (`resource.UnknownStringValue` in Pulumi's SDK).
 * - A secret is an object holding the signature key {@link PULUMI_SIG_KEY}
 *   with the value {@link PULUMI_SECRET_SIG}, and the value under
 *   `plaintext`, `ciphertext` or `value`. Without `--show-secrets` the
 *   display blinds it to `"[secret]"`, so that string counts as a secret too.
 *
 * Recorded from pulumi 3.272.0 against the plunge corpus on floci (#4475,
 * `testdata/pulumi-preview` and `testdata/pulumi-refresh`): previews and
 * refreshes print the unknown sentinel for a value known only after apply,
 * and a secret, in inputs and outputs alike, as the blinded `"[secret]"`;
 * a `pulumi stack export` holds the signature object with its ciphertext.
 *
 * Imports nothing, so the adapters bundle small (#3421).
 */

/** Pulumi's unknown sentinel, `resource.UnknownStringValue`. */
export const PULUMI_UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

/** The key a secret envelope carries, `sig.Key`. */
export const PULUMI_SIG_KEY = "4dabf18193072939515e22adb298388d";

/** The value under {@link PULUMI_SIG_KEY} that marks a secret, `sig.Secret`. */
export const PULUMI_SECRET_SIG = "1b47061264138c4ac30d75fd1eb44270";

/** What the display prints for a secret it does not show. */
export const PULUMI_BLINDED_SECRET = "[secret]";

export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** True for the unknown sentinel itself. */
export function isUnknown(v: unknown): boolean {
  return v === PULUMI_UNKNOWN;
}

/** True for a secret envelope, or the display's blinded secret. */
export function isSecret(v: unknown): boolean {
  if (v === PULUMI_BLINDED_SECRET) return true;
  return isObject(v) && v[PULUMI_SIG_KEY] === PULUMI_SECRET_SIG;
}

/** Whether a value is, or holds anywhere under it, an unknown. A secret's inside is not looked at. */
export function holdsUnknown(v: unknown): boolean {
  if (isUnknown(v)) return true;
  if (isSecret(v)) return false;
  if (Array.isArray(v)) return v.some(holdsUnknown);
  if (isObject(v)) return Object.values(v).some(holdsUnknown);
  return false;
}

/** Whether a value is, or holds anywhere under it, a secret. */
export function holdsSecret(v: unknown): boolean {
  if (isSecret(v)) return true;
  if (Array.isArray(v)) return v.some(holdsSecret);
  if (isObject(v)) return Object.values(v).some(holdsSecret);
  return false;
}

export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return false;
}

/**
 * The segments of a Pulumi property path, the keys of `detailedDiff`:
 * keys joined with `.`, indexes in brackets, and keys that are not
 * identifiers quoted in brackets (`tags["kubernetes.io/role"]`,
 * `ingress[0].cidrBlocks[1]`). The same grammar as chant's plan-observation
 * paths, so a drift attribute's path is the key as Pulumi prints it.
 */
export function propertyPathSegments(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  let current = "";
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === ".") {
      if (current) out.push(current);
      current = "";
    } else if (c === "[") {
      if (current) out.push(current);
      current = "";
      if (path[i + 1] === '"') {
        let key = "";
        let j = i + 2;
        for (; j < path.length && path[j] !== '"'; j++) {
          if (path[j] === "\\" && j + 1 < path.length) j++;
          key += path[j];
        }
        out.push(key);
        const close = path.indexOf("]", j);
        if (close < 0) break;
        i = close;
      } else {
        const close = path.indexOf("]", i);
        if (close < 0) break;
        const raw = path.slice(i + 1, close);
        out.push(/^\d+$/.test(raw) ? Number(raw) : raw);
        i = close;
      }
    } else current += c;
  }
  if (current) out.push(current);
  return out;
}

/** The top-level property a path is under. */
export function topLevelKey(path: string): string {
  const first = propertyPathSegments(path)[0];
  return first === undefined ? path : String(first);
}

/** The value at a property path, or undefined when nothing is there. A secret on the way is returned as it is. */
export function valueAtPath(root: unknown, path: string): unknown {
  let v: unknown = root;
  for (const seg of propertyPathSegments(path)) {
    if (isSecret(v)) return v;
    if (typeof seg === "number") {
      if (!Array.isArray(v)) return undefined;
      v = v[seg];
    } else {
      if (!isObject(v)) return undefined;
      v = v[seg];
    }
  }
  return v;
}

/** A property map's keys, without the `__defaults` bookkeeping Pulumi keeps beside the inputs. */
export function propertyKeys(map: unknown): string[] {
  return isObject(map) ? Object.keys(map).filter((k) => !k.startsWith("__")) : [];
}
