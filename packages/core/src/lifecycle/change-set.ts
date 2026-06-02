/**
 * Change set: a typed, read-only projection of a live diff.
 *
 * `chant lifecycle diff --live` computes a three-way comparison — declared now /
 * last snapshot / live now — and prints it. `buildChangeSet` promotes that
 * same signal into a classified create/update/delete/adopt/noop set that other
 * tooling (reconcile, apply) can act on.
 *
 * Strictly read-only and pure: no I/O, no mutation. The classification reads
 * ownership from the live marker only (populated downstream); until ownership
 * exists, an undeclared live resource is `adopt`, never `delete`. The snapshot
 * is evidence, never the basis for a mutation decision — it must never become
 * load-bearing.
 */
import { diffLive, type AttributeChange, type DiffLiveInput } from "./live-diff";

/**
 * What the projection proposes for a single resource.
 *
 * - `create` — declared in source, absent from live.
 * - `update` — declared and live, but live config drifted.
 * - `delete` — a chant-owned resource that is live but no longer declared.
 *   Only emitted once ownership is known (#121); never inferred from the
 *   snapshot.
 * - `adopt` — live but undeclared, ownership not established → a candidate to
 *   pull back into source, never an auto-delete.
 * - `noop` — declared and live with no drift, or already reconciled.
 */
export type ChangeAction = "create" | "update" | "delete" | "adopt" | "noop";

/**
 * Who answers "is this resource chant's?". `unknown` until a live ownership
 * marker is queried (#120). The change set never escalates `unknown` to a
 * delete.
 */
export type Ownership = "owned" | "foreign" | "unknown";

export interface ChangeSetEntry {
  /** chant entity name. */
  name: string;
  /** Resource type, when known from either side. */
  type?: string;
  action: ChangeAction;
  /** The three-way evidence the classification was derived from. */
  evidence: {
    /** Present in the current build. */
    declared: boolean;
    /** Present in the last snapshot. */
    inSnapshot: boolean;
    /** Observed in the live system right now. */
    live: boolean;
  };
  /** Attribute-level changes, for `update`. */
  deltas?: AttributeChange[];
  /** Live-marker ownership. Defaults to `unknown`. */
  ownership: Ownership;
}

export interface ChangeSet {
  env: string;
  entries: ChangeSetEntry[];
}

/**
 * Build a typed change set from the same inputs `diffLive` consumes.
 *
 * `create`/`update` are precise from declared-vs-live. `delete` is never
 * emitted here — an undeclared live resource classifies as `adopt` until
 * ownership is known.
 */
export function buildChangeSet(env: string, input: DiffLiveInput): ChangeSet {
  const diff = diffLive(input);
  const { declared, observedNow } = input;
  const observedThen = input.observedThen ?? {};

  const driftByName = new Map(
    diff.driftedSinceSnapshot.map((d) => [d.name, d.changes] as const),
  );

  const names = new Set<string>([
    ...declared,
    ...Object.keys(observedNow),
    ...Object.keys(observedThen),
  ]);

  const entries: ChangeSetEntry[] = [];
  for (const name of names) {
    const isDeclared = declared.has(name);
    const live = Object.prototype.hasOwnProperty.call(observedNow, name);
    const inSnapshot = Object.prototype.hasOwnProperty.call(observedThen, name);
    const type = observedNow[name]?.type ?? observedThen[name]?.type;
    const evidence = { declared: isDeclared, inSnapshot, live };

    // Ownership comes from the LIVE marker only (carried on observedNow), never
    // from the snapshot. This is the invariant that keeps the snapshot from
    // becoming load-bearing: a mutation decision (delete) is never made from a
    // record chant has to host.
    const ownership: Ownership = observedNow[name]?.ownership ?? "unknown";

    let action: ChangeAction;
    let deltas: AttributeChange[] | undefined;

    if (isDeclared && !live) {
      // Declared in source, not in the cloud → create.
      action = "create";
    } else if (isDeclared && live) {
      const drift = driftByName.get(name);
      if (drift && drift.length > 0) {
        action = "update";
        deltas = drift;
      } else {
        action = "noop";
      }
    } else if (live) {
      // Live but undeclared. Only a chant-owned orphan is a safe delete; a
      // foreign or unknown orphan can be adopted but never auto-deleted.
      action = ownership === "owned" ? "delete" : "adopt";
    } else {
      // Only in the snapshot: already gone, nothing to reconcile.
      action = "noop";
    }

    entries.push({ name, type, action, evidence, deltas, ownership });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { env, entries };
}

const ACTION_ORDER: ChangeAction[] = ["create", "update", "delete", "adopt", "noop"];

/** Count entries per action. */
export function summarize(cs: ChangeSet): Record<ChangeAction, number> {
  const counts: Record<ChangeAction, number> = {
    create: 0,
    update: 0,
    delete: 0,
    adopt: 0,
    noop: 0,
  };
  for (const e of cs.entries) counts[e.action]++;
  return counts;
}

/** Human-readable render of a change set. Pure — returns a string. */
export function renderChangeSet(cs: ChangeSet): string {
  const counts = summarize(cs);
  const header = ACTION_ORDER.map((a) => `${counts[a]} ${a}`).join(", ");
  const lines: string[] = [`Plan for ${cs.env}: ${header}`];

  for (const action of ACTION_ORDER) {
    const group = cs.entries.filter((e) => e.action === action);
    if (group.length === 0) continue;
    lines.push(`\n${action.toUpperCase()}:`);
    for (const e of group) {
      const own = e.ownership === "unknown" ? "" : ` [${e.ownership}]`;
      lines.push(`  ${e.name}${e.type ? ` (${e.type})` : ""}${own}`);
      for (const d of e.deltas ?? []) {
        lines.push(`      ${d.path}: ${fmt(d.oldValue)} → ${fmt(d.newValue)}`);
      }
    }
  }

  return lines.join("\n");
}

function fmt(v: unknown): string {
  if (v === undefined) return "<unset>";
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "..." : v;
  const json = JSON.stringify(v);
  return json.length > 60 ? json.slice(0, 57) + "..." : json;
}
