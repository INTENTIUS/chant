/**
 * Reading `metadata.managedFields` — chant #1075, consumed by #1076.
 *
 * The API server records, per object, one entry per manager that has written
 * to it, and inside each entry a *set* of the field paths that manager owns.
 * That set is encoded as `fieldsV1`, a nested object whose keys carry a
 * one-or-two-character prefix rather than being plain field names:
 *
 * ```json
 * { "f:spec": { "f:template": { "f:spec": {
 *     "f:containers": { "k:{\"name\":\"web\"}": { ".": {}, "f:image": {} } } } } } }
 * ```
 *
 * | prefix | means                                    | rendered as     |
 * |--------|------------------------------------------|-----------------|
 * | `f:`   | a field of a map                         | `.image`        |
 * | `k:`   | a list item, addressed by its key fields | `[name="web"]`  |
 * | `v:`   | a set item, addressed by its value       | `[="blue"]`     |
 * | `i:`   | a list item, addressed by its index      | `[0]`           |
 * | `.`    | the containing element itself            | (the prefix)    |
 *
 * The rendering above is not invented here: it is what
 * `sigs.k8s.io/structured-merge-diff`'s `fieldpath.Path.String()` produces,
 * which is the same syntax the API server uses for the `field` of a conflict
 * cause (`./conflict.ts`). Both halves of #1076's question — *which fields
 * does chant own* and *which fields is something else fighting over* — have to
 * be comparable as strings, so there is exactly one renderer.
 *
 * This module reads. It does not decide what a difference means; that is
 * #1076's job. What it owes #1076 is the primitive: an object in, per-manager
 * field sets out.
 */

import { isChantFieldManager } from "./field-manager";
import type { K8sObject } from "./types";

/** One `metadata.managedFields` entry, as the API server writes it. */
export interface ManagedFieldsEntry {
  manager?: string;
  /** `Apply` for a server-side apply, `Update` for anything else. */
  operation?: string;
  apiVersion?: string;
  fieldsType?: string;
  fieldsV1?: Record<string, unknown>;
  /** Set when the entry describes a subresource write, e.g. `status`. */
  subresource?: string;
  time?: string;
}

/** One manager's ownership of one object, with `fieldsV1` decoded. */
export interface ManagerFieldSet {
  /** The manager's name, e.g. `chant:web`, `kubectl-client-side-apply`. */
  manager: string;
  /** `Apply` (server-side apply) or `Update` (everything else). */
  operation: string;
  /** The apiVersion the entry was recorded at. */
  apiVersion?: string;
  /** Set when this entry covers a subresource (`status`, `scale`). */
  subresource?: string;
  /** When the write happened, as the server recorded it. */
  time?: string;
  /** Field paths this entry owns, rendered and sorted. */
  fields: string[];
}

/** `metadata.managedFields`, or an empty list when the object carries none. */
export function managedFieldsOf(object: K8sObject | undefined): ManagedFieldsEntry[] {
  const entries = object?.metadata?.managedFields;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e !== null && typeof e === "object")
    .map((e) => e as ManagedFieldsEntry);
}

/**
 * Decode every `managedFields` entry into a manager and its owned paths.
 *
 * Entries are kept separate rather than merged by manager name: a manager can
 * legitimately hold two entries for one object — one for the main resource and
 * one for a subresource, or two at different apiVersions — and collapsing them
 * would lose the distinction #1076 needs when deciding whether a `status`
 * write is chant's business (it is not).
 */
export function fieldSetsOf(object: K8sObject | undefined): ManagerFieldSet[] {
  return managedFieldsOf(object)
    .filter((entry) => typeof entry.manager === "string" && entry.manager.length > 0)
    .map((entry) => ({
      manager: entry.manager!,
      operation: entry.operation ?? "Update",
      ...(entry.apiVersion !== undefined ? { apiVersion: entry.apiVersion } : {}),
      ...(entry.subresource !== undefined ? { subresource: entry.subresource } : {}),
      ...(entry.time !== undefined ? { time: entry.time } : {}),
      fields: fieldPathsOf(entry.fieldsV1),
    }));
}

/** Every manager named on the object, in `managedFields` order, deduplicated. */
export function managersOf(object: K8sObject | undefined): string[] {
  const seen = new Set<string>();
  for (const entry of managedFieldsOf(object)) {
    if (typeof entry.manager === "string" && entry.manager.length > 0) seen.add(entry.manager);
  }
  return [...seen];
}

/**
 * The paths owned by managers matching `manager` — a literal name, or a
 * predicate for the fuzzier questions (#1076 asks "which fields does *any*
 * chant manager own", since a stack rename changes the name).
 *
 * Subresource entries are excluded by default: a controller writing `status`
 * is not competing for the spec chant declared.
 */
export function fieldsOwnedBy(
  object: K8sObject | undefined,
  manager: string | ((manager: string) => boolean),
  options: { includeSubresources?: boolean } = {},
): string[] {
  const matches = typeof manager === "function" ? manager : (m: string) => m === manager;
  const paths = new Set<string>();
  for (const set of fieldSetsOf(object)) {
    if (!matches(set.manager)) continue;
    if (set.subresource !== undefined && options.includeSubresources !== true) continue;
    for (const path of set.fields) paths.add(path);
  }
  return [...paths].sort();
}

/** The paths owned by any chant field manager — {@link isChantFieldManager}. */
export function chantOwnedFields(
  object: K8sObject | undefined,
  options: { includeSubresources?: boolean } = {},
): string[] {
  return fieldsOwnedBy(object, isChantFieldManager, options);
}

/**
 * path → the managers that own it. A path with two owners is not an error:
 * server-side apply lets several appliers co-own a field when they set it to
 * the same value, and an `Update` entry can overlap an `Apply` one.
 */
export function fieldOwners(
  object: K8sObject | undefined,
  options: { includeSubresources?: boolean } = {},
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const set of fieldSetsOf(object)) {
    if (set.subresource !== undefined && options.includeSubresources !== true) continue;
    for (const path of set.fields) {
      const list = owners.get(path) ?? [];
      if (!list.includes(set.manager)) list.push(set.manager);
      owners.set(path, list);
    }
  }
  return owners;
}

/**
 * Render one `fieldsV1` tree to sorted, dotted paths.
 *
 * Exported because a caller with an entry already in hand (a watch event, a
 * stored snapshot) should not have to reassemble a whole object to decode it.
 */
export function fieldPathsOf(fieldsV1: unknown, prefix = ""): string[] {
  return [...collect(fieldsV1, prefix, new Set<string>())].sort();
}

function collect(node: unknown, prefix: string, into: Set<string>): Set<string> {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return into;
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    if (key === ".") {
      // "the containing element itself is owned" — no path segment of its own.
      if (prefix !== "") into.add(prefix);
      continue;
    }
    const segment = renderSegment(key);
    if (segment === undefined) continue;
    const path = `${prefix}${segment}`;
    into.add(path);
    collect(child, path, into);
  }
  return into;
}

/**
 * One `fieldsV1` key to one path segment, or undefined for a key with no
 * recognised prefix (a future encoding chant should skip rather than mangle).
 */
export function renderSegment(key: string): string | undefined {
  if (key.startsWith("f:")) return `.${key.slice(2)}`;
  if (key.startsWith("i:")) return `[${key.slice(2)}]`;
  if (key.startsWith("v:")) return `[=${key.slice(2)}]`;
  if (key.startsWith("k:")) return renderKeySegment(key.slice(2));
  return undefined;
}

/**
 * `k:{"name":"web"}` → `[name="web"]`, and multi-key list items in the order
 * the JSON declares them — `[port=80,protocol="TCP"]`. Values are re-serialised
 * as JSON, which is what makes a string key print with its quotes, matching
 * both `fieldpath.Path.String()` and the conflict causes the server returns.
 */
function renderKeySegment(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Not decodable — keep the raw form rather than inventing a path.
    return `[${json}]`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return `[${json}]`;
  const parts = Object.entries(parsed as Record<string, unknown>).map(
    ([name, value]) => `${name}=${JSON.stringify(value)}`,
  );
  return `[${parts.join(",")}]`;
}
