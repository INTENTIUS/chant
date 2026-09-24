/**
 * Asset pins and record links (#2549; #2524 D4, D6, D18).
 *
 * Artifact relationships are derived from decisions. A decision record pins
 * the workspace files it rests on in `evidence`, each as `{title, path,
 * sha256}`, and names what it governs in `constrains`, as `member:<name>` or
 * `path:<path>`. There is no direct link from a design artifact to code or to
 * another artifact: a reader walks from a file to the decisions whose
 * `constrains` cover it, and from them to their pinned assets.
 *
 * A pin is checked against the tree a read looks at (the working tree, or a
 * revision's git objects). A file whose bytes hash differently is `drifted`,
 * and one that is gone is `missing`. Neither makes the record invalid: the
 * record is still what was decided, and the drift is reported beside it.
 *
 * Which front-matter fields hold pins and links is the kind's data
 * (`pins.field`, `constrains.field`), so this module never names `evidence`.
 */

import { sha256Hex } from "../content-digest";
import type { RecordWarning } from "./records";
import type { WorkspaceTree } from "./tree";

/**
 * A path from the workspace root: `/` separators, no leading `/`, no `.` or
 * `..` segment, no empty segment, no backslash or control character and no
 * trailing `/`. The decision schema holds the same pattern.
 */
export const WORKSPACE_PATH_PATTERN = String.raw`(?!/)(?!(?:[^/]*/)*\.{1,2}(?:/|$))(?!.*//)[^\\\u0000-\u001f]*[^/\\\u0000-\u001f]`;
const WORKSPACE_PATH = new RegExp(`^${WORKSPACE_PATH_PATTERN}$`, "u");
const SHA256 = /^[0-9a-f]{64}$/;

export function isWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_PATH.test(value);
}

/**
 * `pinned`: the file hashes to the pin. `drifted`: it doesn't. `missing`: it
 * isn't there. `stale`: it hashes to the pin, which a record this one
 * supersedes pinned too, so the decision changed and the artifact did not.
 */
export type PinState = "pinned" | "drifted" | "missing" | "stale";

/** One pinned file, as the tree read has it. */
export interface AssetPin {
  /** From the workspace root. */
  path: string;
  /** The hash the record pins. */
  sha256: string;
  /** The hash of the file in the tree read, or null when it is missing. */
  actual: string | null;
  state: PinState;
}

/** The well-formed pins in a record's `field` list: entries with a workspace path and a hex sha256. */
export function pinEntries(data: Record<string, unknown> | null, field: string): { path: string; sha256: string }[] {
  const list = data?.[field];
  if (!Array.isArray(list)) return [];
  const out: { path: string; sha256: string }[] = [];
  for (const e of list) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
    const { path, sha256 } = e as Record<string, unknown>;
    if (isWorkspacePath(path) && typeof sha256 === "string" && SHA256.test(sha256)) out.push({ path, sha256 });
  }
  return out;
}

/** The hex SHA-256 of the file at `path` in `tree`, or undefined when it is not a file there. */
export function fileDigest(tree: WorkspaceTree, path: string): string | undefined {
  if (tree.stat(path) !== "file") return undefined;
  const bytes = tree.bytes ? tree.bytes(path) : Buffer.from(tree.read(path), "utf-8");
  return sha256Hex(bytes);
}

/** Check each pin against `tree`, rooted at the workspace root. */
export function checkPins(pins: { path: string; sha256: string }[], tree: WorkspaceTree): { assets: AssetPin[]; warnings: RecordWarning[] } {
  const assets: AssetPin[] = [];
  const warnings: RecordWarning[] = [];
  for (const pin of pins) {
    const actual = fileDigest(tree, pin.path) ?? null;
    const state: PinState = actual === null ? "missing" : actual === pin.sha256 ? "pinned" : "drifted";
    assets.push({ ...pin, actual, state });
    if (state === "missing") {
      warnings.push({ code: "asset-missing", message: `evidence pins ${pin.path}, which does not exist${tree.label}` });
    } else if (state === "drifted") {
      warnings.push({
        code: "asset-drift",
        message: `${pin.path} changed since it was pinned: sha256 ${pin.sha256.slice(0, 12)} is pinned, the file${tree.label} hashes to ${actual!.slice(0, 12)}`,
      });
    }
  }
  return { assets, warnings };
}

// ── Record links ─────────────────────────────────────────────────────────────

/** The kinds of link a record has in `chant workspace graph`. Closed. */
export const RECORD_LINK_KINDS = ["asset", "constrains"] as const;

/** A link from a record to a workspace path or member, a row of the graph's `links`. */
export interface RecordLinkRow {
  kind: (typeof RECORD_LINK_KINDS)[number];
  origin: "declared";
  resolves: "source";
  /** The record's kind, such as `decision`. */
  recordKind: string;
  /** The record's id. */
  record: string;
  /** The record file, from the repository root. */
  recordPath: string;
  /** For `asset`, the pinned path; for `constrains`, the entry as written (`member:<name>` or `path:<path>`). */
  target: string;
  /** The member the target is, or holds it; null when no member does. */
  member: string | null;
  /** `pinned`, `drifted`, `missing` or `stale` for an asset; `resolved` or `missing` for constrains. */
  status: PinState | "resolved";
  reason: string | null;
  /** For an asset: the pinned hash and the hash in the tree read. */
  sha256?: string;
  actual?: string | null;
}

/** The member whose directory holds `path` (the deepest one), or null. */
export function memberHolding(path: string, members: readonly { name: string; dir: string }[]): string | null {
  let best: { name: string; dir: string } | null = null;
  for (const m of members) {
    const inside = m.dir === "." || path === m.dir || path.startsWith(`${m.dir}/`);
    if (inside && (!best || best.dir === "." || m.dir.length > best.dir.length)) best = m;
  }
  return best?.name ?? null;
}

/** Whether a `path:` constraint covers `file`: the same path, or a directory above it. */
export function constraintCovers(constraint: string, file: string): boolean {
  return file === constraint || file.startsWith(`${constraint}/`);
}

/** A record as the link rows read it. */
export interface LinkedRecord {
  id: string | null;
  path: string;
  supersededBy: string | null;
  data: Record<string, unknown> | null;
  assets: AssetPin[];
}

/**
 * The link rows of the records of one kind: an `asset` row per pin and a
 * `constrains` row per `member:` or `path:` entry. Superseded records and
 * records with no id have none, since their links no longer hold. Paths
 * resolve in `tree` (the workspace root), members in `members`.
 */
export function recordLinkRows(
  kindName: string,
  records: readonly LinkedRecord[],
  constrainsField: string | undefined,
  tree: WorkspaceTree,
  members: readonly { name: string; dir: string }[],
): RecordLinkRow[] {
  const rows: RecordLinkRow[] = [];
  for (const r of records) {
    if (r.id === null || r.supersededBy !== null) continue;
    const base = { origin: "declared" as const, resolves: "source" as const, recordKind: kindName, record: r.id, recordPath: r.path };
    for (const a of r.assets) {
      rows.push({
        kind: "asset",
        ...base,
        target: a.path,
        member: memberHolding(a.path, members),
        status: a.state,
        reason:
          a.state === "missing"
            ? `${a.path} does not exist${tree.label}`
            : a.state === "drifted"
              ? `${a.path} changed since ${r.id} pinned it`
              : a.state === "stale"
                ? `${a.path} has not changed since a record ${r.id} supersedes pinned it`
                : null,
        sha256: a.sha256,
        actual: a.actual,
      });
    }
    const list = constrainsField ? r.data?.[constrainsField] : undefined;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      if (entry.startsWith("member:")) {
        const name = entry.slice("member:".length);
        const known = members.some((m) => m.name === name);
        rows.push({ kind: "constrains", ...base, target: entry, member: known ? name : null, status: known ? "resolved" : "missing", reason: known ? null : `${name} is not a member of this workspace` });
      } else if (entry.startsWith("path:")) {
        const path = entry.slice("path:".length);
        if (!isWorkspacePath(path)) continue;
        const exists = tree.stat(path) !== undefined;
        rows.push({
          kind: "constrains",
          ...base,
          target: entry,
          member: memberHolding(path, members),
          status: exists ? "resolved" : "missing",
          reason: exists ? null : `${path} does not exist${tree.label}`,
        });
      }
    }
  }
  return rows;
}
