/**
 * Change set: a typed, read-only projection of a live diff.
 *
 * `chant lifecycle diff --live` computes a three-way comparison — declared now /
 * last snapshot / live now — and prints it. `buildChangeSet` promotes that
 * same signal into a classified create/update/delete/adopt/runtime/noop set
 * that other tooling (reconcile, apply) can act on.
 *
 * Strictly read-only and pure: no I/O, no mutation. The classification reads
 * ownership from the live marker only (populated downstream); until ownership
 * exists, an undeclared live resource is `adopt`, never `delete`. The snapshot
 * is evidence, never the basis for a mutation decision — it must never become
 * load-bearing.
 */
import { diffLive, type AttributeChange, type DiffLiveInput } from "./live-diff";
import { unobservedReasonText, type UnobservedReason } from "../observation";

/**
 * What the projection proposes for a single resource.
 *
 * - `create` — declared in source, and the provider **confirmed** it absent.
 * - `update` — declared and live, but live config drifted.
 * - `delete` — a chant-owned resource that is live but no longer declared.
 *   Only emitted once ownership is known (#121); never inferred from the
 *   snapshot.
 * - `adopt` — live but undeclared, ownership not established → a candidate to
 *   pull back into source, never an auto-delete.
 * - `runtime` — live but undeclared, and its owner-reference chain reaches a
 *   declared entity (#1077): a Pod a declared Deployment's controller
 *   created, for instance. Never a delete, never an adopt candidate — it is
 *   not drift, just the runtime doing its job. `runtimeOwner` names the
 *   declared entity it belongs to.
 * - `noop` — declared and live with no drift, or already reconciled.
 * - `unobserved` — declared, and the lexicon could not look (#1089). Not a
 *   proposal at all: it is the plan admitting a hole. Never a create, never a
 *   delete. Read `unobservedReason` for which hole.
 */
export type ChangeAction = "create" | "update" | "delete" | "adopt" | "runtime" | "noop" | "unobserved";

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
    /** Observed present in the live system right now. */
    live: boolean;
    /**
     * The lexicon actually looked at this entity (#1089). `false` with
     * `live: false` means "unknown", not "absent" — the distinction the whole
     * change set now rests on. Absent-and-looked-at is `observed: true,
     * live: false`.
     */
    observed: boolean;
  };
  /** Attribute-level changes, for `update`. */
  deltas?: AttributeChange[];
  /** Live-marker ownership. Defaults to `unknown`. */
  ownership: Ownership;
  /** Why the entity could not be observed, for `action: "unobserved"` (#1089). */
  unobservedReason?: UnobservedReason;
  /** Human-readable backing for `unobservedReason` (the failing command, the missing binding). */
  unobservedDetail?: string;
  /** The declared entity this resource's owner chain resolves to, for `action: "runtime"` (#1077). */
  runtimeOwner?: string;
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
 *
 * A declared entity the lexicon could not observe (`input.unobserved`, #1089)
 * classifies as `unobserved` and nothing else: no `create` is ever synthesized
 * from a read that did not happen.
 */
export function buildChangeSet(env: string, input: DiffLiveInput): ChangeSet {
  const diff = diffLive(input);
  const { declared, observedNow } = input;
  const observedThen = input.observedThen ?? {};
  const unobservedInput = input.unobserved ?? {};

  const driftByName = new Map(
    diff.driftedSinceSnapshot.map((d) => [d.name, d.changes] as const),
  );

  const names = new Set<string>([
    ...declared,
    ...Object.keys(observedNow),
    ...Object.keys(observedThen),
    ...Object.keys(unobservedInput),
  ]);

  const entries: ChangeSetEntry[] = [];
  for (const name of names) {
    const isDeclared = declared.has(name);
    const live = Object.prototype.hasOwnProperty.call(observedNow, name);
    const inSnapshot = Object.prototype.hasOwnProperty.call(observedThen, name);
    // A returned resource was observed by definition; `unobserved` only counts
    // for entities the lexicon did not return.
    const unobservedEntry = live ? undefined : unobservedInput[name];
    const type = observedNow[name]?.type ?? observedThen[name]?.type ?? unobservedEntry?.type;
    const evidence = { declared: isDeclared, inSnapshot, live, observed: !unobservedEntry };

    // Ownership comes from the LIVE marker only (carried on observedNow), never
    // from the snapshot. This is the invariant that keeps the snapshot from
    // becoming load-bearing: a mutation decision (delete) is never made from a
    // record chant has to host.
    const ownership: Ownership = observedNow[name]?.ownership ?? "unknown";

    // Owner-reference chain (#1077), same live-only provenance as ownership
    // above. Only a `declared` root changes the classification; `unknown` is
    // deliberately not escalated (#1168's tri-state precedent — an
    // unconfirmed chain never earns the more confident verdict).
    const runtimeOwner =
      !isDeclared && observedNow[name]?.ownerChain?.root === "declared"
        ? observedNow[name]!.ownerChain!.entity
        : undefined;

    let action: ChangeAction;
    let deltas: AttributeChange[] | undefined;

    if (unobservedEntry) {
      // The lexicon never looked. Absence is not established, so neither a
      // create (declared) nor a delete/adopt (undeclared) can be proposed —
      // the entry exists to say the plan has a hole here.
      action = "unobserved";
    } else if (isDeclared && !live) {
      // Declared in source, and the provider confirmed it absent → create.
      action = "create";
    } else if (isDeclared && live) {
      const drift = driftByName.get(name);
      if (drift && drift.length > 0) {
        action = "update";
        deltas = drift;
      } else {
        action = "noop";
      }
    } else if (live && runtimeOwner) {
      // Live, undeclared, and its owner chain reaches a declared entity
      // (#1077) — expected runtime, never a delete/adopt candidate, checked
      // ahead of the ownership marker below: even a runtime child that
      // happens to carry chant's own marker (label propagation from its
      // owner's template) must never be proposed for deletion.
      action = "runtime";
    } else if (live) {
      // Live but undeclared. Only a chant-owned orphan is a safe delete; a
      // foreign or unknown orphan can be adopted but never auto-deleted.
      action = ownership === "owned" ? "delete" : "adopt";
    } else {
      // Only in the snapshot: already gone, nothing to reconcile.
      action = "noop";
    }

    entries.push({
      name,
      type,
      action,
      evidence,
      deltas,
      ownership,
      ...(unobservedEntry
        ? {
            unobservedReason: unobservedEntry.reason,
            ...(unobservedEntry.detail ? { unobservedDetail: unobservedEntry.detail } : {}),
          }
        : {}),
      ...(runtimeOwner ? { runtimeOwner } : {}),
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { env, entries };
}

const ACTION_ORDER: ChangeAction[] = ["create", "update", "delete", "adopt", "runtime", "noop", "unobserved"];

/** Count entries per action. */
export function summarize(cs: ChangeSet): Record<ChangeAction, number> {
  const counts: Record<ChangeAction, number> = {
    create: 0,
    update: 0,
    delete: 0,
    adopt: 0,
    runtime: 0,
    noop: 0,
    unobserved: 0,
  };
  for (const e of cs.entries) counts[e.action]++;
  return counts;
}

/**
 * GitLab MR plan widget report.
 *
 * GitLab renders an `artifacts:reports:terraform` artifact in the merge-request
 * UI as "N to add, M to change, K to delete". The format is generic — any tool
 * that emits this JSON gets the widget — and the chant plan maps onto it
 * directly. Only the mutating actions count: `adopt`, `runtime`, `noop` and
 * `unobserved` are excluded, since the widget has no column for "live but
 * undeclared", "expected runtime child" (#1077), "no change", or "could not
 * look" (#1089). The widget is therefore a floor, not a complete plan: read
 * the full change set when entities are unobserved or classified runtime.
 *
 * The widget label reads "Terraform" regardless of producer; that is GitLab's
 * fixed string, not a claim chant makes.
 */
export interface GitlabMrReport {
  create: number;
  update: number;
  delete: number;
}

/** Project a change set onto the GitLab MR plan widget shape. Pure. */
export function gitlabMrReport(cs: ChangeSet): GitlabMrReport {
  const counts = summarize(cs);
  return { create: counts.create, update: counts.update, delete: counts.delete };
}

/** Human-readable render of a change set. Pure — returns a string. */
export function renderChangeSet(cs: ChangeSet): string {
  const counts = summarize(cs);
  const header = ACTION_ORDER.map((a) => `${counts[a]} ${a}`).join(", ");
  const lines: string[] = [`Plan for ${cs.env}: ${header}`];

  for (const action of ACTION_ORDER) {
    const group = cs.entries.filter((e) => e.action === action);
    if (group.length === 0) continue;
    lines.push(
      action === "unobserved"
        ? "\nUNOBSERVED (declared; chant could not read live state — no action proposed):"
        : action === "runtime"
          ? "\nRUNTIME (owned by a declared resource; not drift, never a delete/adopt candidate):"
          : `\n${action.toUpperCase()}:`,
    );
    for (const e of group) {
      const own = e.ownership === "unknown" ? "" : ` [${e.ownership}]`;
      const why = e.unobservedReason
        ? ` — ${unobservedReasonText(e.unobservedReason)}${e.unobservedDetail ? `: ${e.unobservedDetail}` : ""}`
        : "";
      const owner = e.runtimeOwner ? ` — owned by ${e.runtimeOwner}` : "";
      lines.push(`  ${e.name}${e.type ? ` (${e.type})` : ""}${own}${why}${owner}`);
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
