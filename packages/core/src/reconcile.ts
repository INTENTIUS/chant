/**
 * Provider-agnostic reconcile primitive.
 *
 * The reusable machinery behind a declarative reconcile loop, with NO knowledge
 * of any specific provider (GitHub, GitLab, a cloud, …): the change-set model,
 * the generic collection diff (selective-by-omission + ownership-gated deletes),
 * the plan renderer, and the guardrail framework (rename resolution + a removal
 * cap + a pluggable check runner).
 *
 * A consumer application (e.g. github-warden) builds its provider-specific resource diffing,
 * live-state types, and domain guardrails on top of this, and drives them with
 * the generic `runReconcile` loop + `Cycle` interface (below). It complements
 * chant's `ownership.ts` marker contract: ownership markers make a `delete`
 * precise; this module decides *which* entries are creates / updates / deletes
 * in the first place.
 *
 * Consumed as `@intentius/chant/reconcile`. The diff and guardrail primitives
 * are pure and clock-free; `runReconcile` is the orchestration loop and is the
 * only part that drives I/O (through the provider's `Cycle` implementations).
 */

import { GOVERNANCE_VERBS, type GovernanceVerb } from "./governance.js";

// ---------------------------------------------------------------------------
// Change-set model
// ---------------------------------------------------------------------------

/** A single field-level change: what the old value was and what it will become. */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** The kind of operation this change represents. */
export type ChangeKind = "create" | "update" | "delete";

/** A single entry in the change set. */
export interface ChangeSetEntry {
  kind: ChangeKind;
  /** High-level resource category (e.g. "team", "member", "branch-protection"). */
  resourceType: string;
  /**
   * Cross-provider governance category. `resourceType` stays the
   * provider-specific display string; the verb is the shared grammar SCM and
   * cloud plans group by. Stamped by `runReconcile` from the cycle's `verb`.
   */
  verb?: GovernanceVerb;
  /**
   * Unique key identifying this resource within its type.
   * - For top-level resources: a single name (team slug, member login, …).
   * - For nested resources: "<parent>/<child>" (e.g. "backend/alice").
   */
  key: string;
  /** The live value before the change (absent for creates). */
  before?: unknown;
  /** The desired value after the change (absent for deletes). */
  after?: unknown;
  /** Field-level diff, populated for `update` entries. */
  fields?: FieldChange[];
}

/** The full set of changes to reconcile for one scope (e.g. one org). */
export interface ChangeSet {
  /** Scope identifier this change set applies to (e.g. a GitHub org login). */
  org: string;
  /** All proposed changes, in stable order. */
  entries: ChangeSetEntry[];
  /**
   * Live entries under management across the diffed collections (#2067).
   * `diffCollection` returns each collection's live count so the diff layer
   * can sum it here. Optional — when absent, guardrails that want a live
   * denominator (see {@link removalDeltaCap}) fall back to the plan-relative
   * one.
   *
   * Superseded by {@link ChangeSet.managedCounts}: a single pooled total lets
   * non-deletable and cross-collection live entries dilute the delete
   * fraction (wiping 3 of 4 teams reads as 12.5% when 20 team members pad
   * the pool). Kept for compatibility — a change set carrying only this
   * total keeps the 0.55.0 pooled behavior.
   */
  managedCount?: number;
  /**
   * Live managed-entry counts per resource type, keyed by
   * `ChangeSetEntry.resourceType`. When present, {@link removalDeltaCap}
   * evaluates the delete fraction per resource type instead of against the
   * pooled `managedCount`, so live entries of one type cannot dilute a wipe
   * of another. Supersedes `managedCount`.
   */
  managedCounts?: Readonly<Record<string, number>>;
}

/** Options controlling diff behaviour. */
export interface DiffOptions {
  /**
   * Ownership predicate for collection entries. The diff only emits a `delete`
   * for a live entry absent from desired when this returns `true`. Omitted →
   * deletes are never emitted ("assume nothing is owned").
   */
  isOwned?: (resourceType: string, key: string) => boolean;

  /**
   * Reference "now" in epoch milliseconds, used by time-based diffs. Callers
   * inject `Date.now()` when unset; tests pass an explicit value.
   */
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// Generic field/value diffing
// ---------------------------------------------------------------------------

/** Deep value equality via JSON for plain data (config/live snapshots). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff fields of `desired` against `live`, returning one `FieldChange` per
 * differing field. When `keys` is given, only those keys are compared (and only
 * when present in `desired`); otherwise every key in `desired` is compared.
 * Selective-by-omission: keys absent from `desired` are never compared.
 */
export function diffFields(
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
  keys?: string[],
): FieldChange[] {
  const fields: FieldChange[] = [];
  const compareKeys = keys ?? Object.keys(desired);
  for (const key of compareKeys) {
    if (keys && !Object.prototype.hasOwnProperty.call(desired, key)) continue;
    const dv = desired[key];
    const lv = live[key];
    if (!deepEqual(dv, lv)) fields.push({ field: key, before: lv, after: dv });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Generic collection diff
// ---------------------------------------------------------------------------

/** Parameters for {@link diffCollection}. */
export interface DiffCollectionParams<D, L> {
  /** Resource type stamped on emitted entries. */
  resourceType: string;
  /** Prefix prepended to each entry key (e.g. "<parent>/"). Default "". */
  keyPrefix?: string;
  /** Desired entries, keyed by logical key. */
  desired: Map<string, D>;
  /** Live entries, keyed by logical key. */
  live: Map<string, L>;
  /** Fields that differ → an update. Return `[]` for "no change". */
  compareFields: (desired: D, live: L) => FieldChange[];
  /** `after` value for a create entry. Defaults to the desired value. */
  createAfter?: (key: string, desired: D) => unknown;
  /** `after` value for an update entry. Defaults to the desired value. */
  updateAfter?: (key: string, desired: D, live: L) => unknown;
  opts: DiffOptions;
  out: ChangeSetEntry[];
}

/**
 * The generic managed-collection diff: creates for desired-not-live, updates
 * when `compareFields` reports differences, and ownership-gated deletes for
 * live-not-desired. This is the selective-by-omission + ownership-gated-delete
 * pattern shared by every keyed-collection diff.
 *
 * Returns the live entry count for this collection, so the diff layer can sum
 * `ChangeSet.managedCount` across the collections it diffs (#2067).
 */
export function diffCollection<D, L>(params: DiffCollectionParams<D, L>): number {
  const {
    resourceType,
    keyPrefix = "",
    desired,
    live,
    compareFields,
    createAfter,
    updateAfter,
    opts,
    out,
  } = params;

  for (const [key, d] of desired) {
    const entryKey = `${keyPrefix}${key}`;
    const l = live.get(key);
    if (l === undefined) {
      out.push({
        kind: "create",
        resourceType,
        key: entryKey,
        after: createAfter ? createAfter(key, d) : d,
      });
      continue;
    }
    const fields = compareFields(d, l);
    if (fields.length > 0) {
      out.push({
        kind: "update",
        resourceType,
        key: entryKey,
        before: l,
        after: updateAfter ? updateAfter(key, d, l) : d,
        fields,
      });
    }
  }

  for (const [key, l] of live) {
    if (desired.has(key)) continue;
    const entryKey = `${keyPrefix}${key}`;
    if (opts.isOwned?.(resourceType, entryKey)) {
      out.push({ kind: "delete", resourceType, key: entryKey, before: l });
    }
  }

  return live.size;
}

// ---------------------------------------------------------------------------
// Summary / rendering
// ---------------------------------------------------------------------------

/** Count entries per change kind. */
export function summarizeChangeSet(cs: ChangeSet): Record<ChangeKind, number> {
  const counts: Record<ChangeKind, number> = { create: 0, update: 0, delete: 0 };
  for (const e of cs.entries) counts[e.kind]++;
  return counts;
}

/** Human-readable plan summary for dry-run output. Pure. */
export function renderChangeSet(cs: ChangeSet): string {
  const counts = summarizeChangeSet(cs);
  const header = `Plan for ${cs.org}: ${counts.create} to create, ${counts.update} to update, ${counts.delete} to delete`;

  if (cs.entries.length === 0) return `${header}\nNo changes.`;

  const lines: string[] = [header];
  const byKind: Record<ChangeKind, ChangeSetEntry[]> = { create: [], update: [], delete: [] };
  for (const e of cs.entries) byKind[e.kind].push(e);

  const ORDER: ChangeKind[] = ["create", "update", "delete"];
  for (const kind of ORDER) {
    let group = byKind[kind];
    if (group.length === 0) continue;
    // Verb-aware grouping: when entries carry governance verbs, order
    // each section by verb (vocabulary order, unverbed entries last) so mixed
    // plans read category-by-category. Stable, and line format is unchanged —
    // a verbless change set renders exactly as before.
    if (group.some((e) => e.verb)) {
      const rank = (e: ChangeSetEntry): number =>
        e.verb ? GOVERNANCE_VERBS.indexOf(e.verb) : GOVERNANCE_VERBS.length;
      group = [...group].sort((a, b) => rank(a) - rank(b));
    }
    lines.push(`\n${kind.toUpperCase()}:`);
    for (const e of group) {
      lines.push(`  [${e.resourceType}] ${e.key}`);
      for (const f of e.fields ?? []) {
        lines.push(`    ${f.field}: ${fmt(f.before)} → ${fmt(f.after)}`);
      }
    }
  }
  return lines.join("\n");
}

function fmt(v: unknown): string {
  if (v === undefined) return "<unset>";
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 57)}...` : v;
  const json = JSON.stringify(v);
  return json.length > 60 ? `${json.slice(0, 57)}...` : json;
}

// ---------------------------------------------------------------------------
// Guardrail framework
// ---------------------------------------------------------------------------

/** A single tripped guardrail with a human-readable message. */
export interface GuardrailDiagnostic {
  /** Short identifier, e.g. "removalDeltaCap". */
  guardrail: string;
  /** Clear, actionable description of why the apply was refused. */
  message: string;
}

/** Aggregated guardrail result. */
export type GuardrailResult = { ok: true } | { ok: false; diagnostics: GuardrailDiagnostic[] };

/** Live context threaded to guardrail checks by `runGuardrailChecks` (#2067). */
export interface GuardrailContext {
  /** Live entries under management this cycle (see `ChangeSet.managedCount`). */
  managedCount?: number;
}

/**
 * A guardrail check over a (rename-resolved) change set. Returns null when it
 * passes. `ctx` carries live context when the caller has it (#2067); a check
 * written against the single-argument shape keeps working unchanged.
 */
export type GuardrailCheck = (resolved: ChangeSet, ctx?: GuardrailContext) => GuardrailDiagnostic | null;

/** Config for `removalDeltaCap`. */
export interface RemovalDeltaCapOptions {
  /**
   * Max fraction of pre-existing entries that may be deleted. Must be in
   * (0,1]: `removalDeltaCap` throws an `Error` on any value outside that
   * range (0, negatives, above 1, NaN) rather than silently disabling the
   * cap. Default 0.25.
   */
  maxFraction?: number;
  /**
   * Pooled live managed-entry denominator (#2067). When positive, deletes are
   * divided by this count of live entries under management instead of the
   * plan's non-create entries — a converged cycle deleting one stale entry
   * out of many no longer reads as 1/1 = 100%. Defaults to
   * `changeSet.managedCount`; when neither is present (or not positive) the
   * cap keeps its plan-relative behavior.
   *
   * Superseded by {@link RemovalDeltaCapOptions.managedTotals} — the pooled
   * total lets unrelated live entries dilute the delete fraction.
   */
  managedTotal?: number;
  /**
   * Live managed-entry counts per resource type (keys =
   * `ChangeSetEntry.resourceType`), mirroring {@link ChangeSet.managedCounts}
   * and winning over it when both are present. When per-type counts are
   * available from either source, the cap is evaluated per resource type:
   * each type's deletes divide by that type's live count when present and
   * positive, else by that type's own plan non-creates. Supersedes
   * `managedTotal`.
   */
  managedTotals?: Readonly<Record<string, number>>;
}

/**
 * Resolve rename aliases. A create entry carrying a `previously` key matching a
 * delete entry's key OF THE SAME RESOURCE TYPE is collapsed into an update,
 * removing the delete. Matching across resource types would let e.g. a team
 * create with `previously: "old"` swallow an unrelated member delete keyed
 * "old", hiding a real delete from guardrail counting. Returns a new ChangeSet
 * with renames resolved. Provider-agnostic — works on any entry whose
 * `after.previously` is a string.
 */
export function resolveRenames(changeSet: ChangeSet): ChangeSet {
  // Keys and resource types are both free-form strings, so scope the lookup
  // with an unambiguous composite key ("\u0000" cannot appear in either).
  const typedKey = (resourceType: string, key: string): string => `${resourceType}\u0000${key}`;

  const deleteEntries = new Map<string, ChangeSetEntry>();
  for (const e of changeSet.entries) {
    if (e.kind === "delete") deleteEntries.set(typedKey(e.resourceType, e.key), e);
  }

  const resolvedDeletes = new Set<string>();
  const resolvedCreates = new Set<string>();
  const syntheticUpdates: ChangeSetEntry[] = [];

  for (const e of changeSet.entries) {
    if (e.kind !== "create") continue;
    const after = e.after as Record<string, unknown> | undefined;
    if (!after) continue;
    const previously = after["previously"];
    if (typeof previously !== "string") continue;

    const deleted = deleteEntries.get(typedKey(e.resourceType, previously));
    if (!deleted) continue;

    resolvedDeletes.add(typedKey(e.resourceType, previously));
    resolvedCreates.add(typedKey(e.resourceType, e.key));
    syntheticUpdates.push({
      kind: "update",
      resourceType: e.resourceType,
      key: e.key,
      before: deleted.before,
      after: e.after,
      fields: [{ field: "key", before: previously, after: e.key }],
    });
  }

  if (resolvedDeletes.size === 0) return changeSet;

  const filteredEntries = changeSet.entries.filter(
    (e) =>
      !(e.kind === "delete" && resolvedDeletes.has(typedKey(e.resourceType, e.key))) &&
      !(e.kind === "create" && resolvedCreates.has(typedKey(e.resourceType, e.key))),
  );

  return { ...changeSet, entries: [...filteredEntries, ...syntheticUpdates] };
}

/**
 * Refuse if deletes exceed `maxFraction` of the pre-existing managed entries
 * (deletes + updates; creates excluded so a flood of new entries can't dilute
 * the delete fraction). Guards against a typo wiping the config in one apply.
 *
 * With per-type live counts (`opts.managedTotals`, else
 * `changeSet.managedCounts`) the cap is evaluated PER RESOURCE TYPE: for each
 * type with deletes, that type's deletes divide by that type's live count when
 * present and positive, else by that type's own plan non-creates. Any type
 * over `maxFraction` blocks, and the diagnostic names the worst offender. The
 * pooled denominator this replaces was unsafe — live entries of one type
 * (team members, repos) diluted a wipe of another (teams, org secrets) below
 * the cap.
 *
 * With only a pooled live denominator (`opts.managedTotal`, else
 * `changeSet.managedCount`; #2067) deletes are measured against the pooled
 * live entries under management — so a converged cycle's plan of exactly one
 * stale delete does not trip at 1/1 = 100%. Without either, behavior is
 * plan-relative as before.
 *
 * Throws on a `maxFraction` outside (0,1] (NaN included) — fail closed, never
 * silently disable the cap.
 *
 * CONTRACT: pass a RENAME-RESOLVED change set (see {@link resolveRenames}).
 */
export function removalDeltaCap(
  changeSet: ChangeSet,
  opts: RemovalDeltaCapOptions = {},
): GuardrailDiagnostic | null {
  const maxFraction = opts.maxFraction ?? 0.25;
  if (!(maxFraction > 0 && maxFraction <= 1)) {
    // The negated form catches NaN too. A bad cap must never pass silently:
    // maxFraction: 5 would otherwise wave every wipe through.
    throw new Error(
      `removalDeltaCap: maxFraction must be in (0, 1], got ${String(maxFraction)}`,
    );
  }
  const managedTotals = opts.managedTotals ?? changeSet.managedCounts;
  if (managedTotals !== undefined) {
    return removalDeltaCapPerType(changeSet, managedTotals, maxFraction);
  }

  const deletes = changeSet.entries.filter((e) => e.kind === "delete").length;
  const managedTotal = opts.managedTotal ?? changeSet.managedCount;
  if (managedTotal !== undefined && managedTotal > 0) {
    const fraction = deletes / managedTotal;
    if (fraction > maxFraction) {
      return {
        guardrail: "removalDeltaCap",
        message:
          `${deletes} of ${managedTotal} live managed entries (${Math.round(fraction * 100)}%) would be deleted, ` +
          `exceeding the ${Math.round(maxFraction * 100)}% threshold. ` +
          `Check for typos in config or raise maxFraction to proceed.`,
      };
    }
    return null;
  }

  const total = changeSet.entries.filter((e) => e.kind !== "create").length;
  if (total === 0) return null;
  const fraction = deletes / total;
  if (fraction > maxFraction) {
    return {
      guardrail: "removalDeltaCap",
      message:
        `${deletes} of ${total} managed entries (${Math.round(fraction * 100)}%) would be deleted, ` +
        `exceeding the ${Math.round(maxFraction * 100)}% threshold. ` +
        `Check for typos in config or raise maxFraction to proceed.`,
    };
  }
  return null;
}

/** One resource type's delete fraction, for the per-type cap evaluation. */
interface TypeFraction {
  resourceType: string;
  deletes: number;
  total: number;
  fraction: number;
  /** True when `total` is a live count; false for the plan-relative fallback. */
  live: boolean;
}

/**
 * Per-resource-type evaluation for {@link removalDeltaCap}. Each type with
 * deletes gets its own denominator: the type's live count from `managedTotals`
 * when present and positive, else that type's plan non-creates (the same
 * plan-relative rule as the typeless cap, scoped to the type). Blocks when ANY
 * type exceeds `maxFraction`; the message leads with the worst offender and
 * lists the rest.
 */
function removalDeltaCapPerType(
  changeSet: ChangeSet,
  managedTotals: Readonly<Record<string, number>>,
  maxFraction: number,
): GuardrailDiagnostic | null {
  const deletesByType = new Map<string, number>();
  const nonCreatesByType = new Map<string, number>();
  for (const e of changeSet.entries) {
    if (e.kind === "create") continue;
    nonCreatesByType.set(e.resourceType, (nonCreatesByType.get(e.resourceType) ?? 0) + 1);
    if (e.kind === "delete") {
      deletesByType.set(e.resourceType, (deletesByType.get(e.resourceType) ?? 0) + 1);
    }
  }

  const tripping: TypeFraction[] = [];
  for (const [resourceType, deletes] of deletesByType) {
    const liveCount = managedTotals[resourceType];
    // A zero (or negative) live count means "no live info for this type",
    // never a looser or divide-by-zero cap — same rule as the pooled total.
    const live = liveCount !== undefined && liveCount > 0;
    const total = live ? (liveCount as number) : nonCreatesByType.get(resourceType)!;
    const fraction = deletes / total;
    if (fraction > maxFraction) tripping.push({ resourceType, deletes, total, fraction, live });
  }

  if (tripping.length === 0) return null;

  // Worst offender first; deterministic tie-break by delete count then name.
  tripping.sort(
    (a, b) =>
      b.fraction - a.fraction ||
      b.deletes - a.deletes ||
      a.resourceType.localeCompare(b.resourceType),
  );
  const [worst, ...rest] = tripping as [TypeFraction, ...TypeFraction[]];
  const pct = (f: number): number => Math.round(f * 100);
  const describe = (t: TypeFraction): string =>
    `${t.deletes} of ${t.total} ${t.live ? "live" : "planned"} ${t.resourceType} entries (${pct(t.fraction)}%)`;

  return {
    guardrail: "removalDeltaCap",
    message:
      `${describe(worst)} would be deleted, exceeding the ${pct(maxFraction)}% threshold. ` +
      (rest.length > 0 ? `Also over the cap: ${rest.map(describe).join(", ")}. ` : "") +
      `Check for typos in config or raise maxFraction to proceed.`,
  };
}

/**
 * Run a set of guardrail checks against a change set. Resolves renames ONCE,
 * then runs every check on the resolved set, aggregating any diagnostics. The
 * caller composes provider-specific checks (e.g. an admin floor) as closures.
 * `ctx` (optional, #2067) threads live context — e.g. the managed-live count —
 * to every check; single-argument checks ignore it.
 */
export function runGuardrailChecks(
  changeSet: ChangeSet,
  checks: GuardrailCheck[],
  ctx?: GuardrailContext,
): GuardrailResult {
  const resolved = resolveRenames(changeSet);
  const diagnostics: GuardrailDiagnostic[] = [];
  for (const check of checks) {
    const d = check(resolved, ctx);
    if (d) diagnostics.push(d);
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true };
}

// ---------------------------------------------------------------------------
// Reconcile runner (generic over provider client / config / live / scope)
// ---------------------------------------------------------------------------

/** Controls how a cycle tracks its API usage against a shared request budget. */
export interface RateBudget {
  /** Remaining request capacity for this run. */
  readonly remaining: number;
  /** True once `remaining` has reached zero. */
  readonly exhausted: boolean;
  /** Decrement by `n` (default 1). Throws `BudgetExhaustedError` if exhausted. */
  use(n?: number): void;
}

/** Thrown when a cycle or apply step attempts to use an exhausted budget. */
export class BudgetExhaustedError extends Error {
  constructor(message = "rate budget exhausted") {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

class MutableRateBudget implements RateBudget {
  private _remaining: number;
  constructor(initial: number) {
    this._remaining = initial;
  }
  get remaining(): number {
    return this._remaining;
  }
  get exhausted(): boolean {
    return this._remaining <= 0;
  }
  use(n = 1): void {
    if (this.exhausted) throw new BudgetExhaustedError();
    this._remaining = Math.max(0, this._remaining - n);
  }
}

/**
 * A reconcile cycle: fetch live state for one resource domain, build desired
 * state from config, and apply a single `ChangeSetEntry` back to the provider.
 * Generic over the provider client (`TClient`), the per-scope config slice
 * (`TConfig`), the live snapshot (`TLive`), and caller-supplied scope (`TScope`).
 *
 * `scopeId` is the current scope being iterated (e.g. an org login or group
 * path); cycles use it — not `TScope` — for provider API paths, so a multi-scope
 * config targets the right scope. Every network call must charge `budget`.
 */
export interface Cycle<TClient, TConfig, TLive, TScope = unknown> {
  /** Human-readable name, e.g. "branch-protection". */
  name: string;
  /**
   * Cross-provider governance category this cycle reconciles. Every
   * SCM reconciler cycles stamp one; cloud cycles must. Optional
   * only so provider-external Cycle implementations don't break.
   */
  verb?: GovernanceVerb;
  fetchLive(client: TClient, scopeId: string, scope: TScope, budget: RateBudget): Promise<TLive>;
  buildDesired(config: TConfig, scopeId: string, scope: TScope): TConfig;
  apply(
    client: TClient,
    entry: ChangeSetEntry,
    scopeId: string,
    scope: TScope,
    budget: RateBudget,
  ): Promise<void>;
}

/** Per-cycle outcome recorded in the run result. */
export interface CycleResult {
  name: string;
  /** The cycle's governance verb, when it stamps one. */
  verb?: GovernanceVerb;
  /** Scope id this result is for (e.g. an org login). */
  org: string;
  counts: { create: number; update: number; delete: number };
  guardrails: GuardrailResult;
  applied: ChangeSetEntry[];
  failed: Array<{ entry: ChangeSetEntry; error: string }>;
  plan: string;
  guardrailBlocked: boolean;
}

/** A cycle that errored during `fetchLive`/`buildDesired` (non-budget error). */
export interface CycleError {
  name: string;
  org: string;
  stage: "fetchLive" | "buildDesired";
  error: string;
}

/** Work that could not complete due to budget exhaustion. */
export interface DeferredWork {
  skippedCycles: string[];
  skippedEntries: Array<{ cycleName: string; entry: ChangeSetEntry }>;
}

/** Structured result from a single `runReconcile` call. */
export interface ReconcileResult {
  mode: "dry-run" | "apply";
  completed: boolean;
  cycles: CycleResult[];
  errored: CycleError[];
  deferred: DeferredWork;
  budgetRemaining: number;
}

/** Options for `runReconcile`. */
export interface RunReconcileOptions<TClient, TConfig, TLive, TScope = unknown> {
  /** Per-scope configs to reconcile, keyed by scope id (e.g. org login). */
  scopes: Record<string, TConfig>;
  /** Authed provider client, passed to every cycle. */
  client: TClient;
  /** Cycles to run; each runs against every scope in `scopes`. */
  cycles: Array<Cycle<TClient, TConfig, TLive, TScope>>;
  /** Scope forwarded to each cycle (filter/cursor); does not vary by scopeId. */
  scope?: TScope;
  /** "dry-run" (default) computes + reports; "apply" mutates after guardrails. */
  mode?: "dry-run" | "apply";
  /** Provider diff: turn (desired, live) into a ChangeSet for one scope. */
  diff: (scopeId: string, desired: TConfig, live: TLive, opts: DiffOptions) => ChangeSet;
  /** Guardrail check over the change set + live. Defaults to always-ok. */
  guardrails?: (changeSet: ChangeSet, live: TLive) => GuardrailResult;
  /** Diff options forwarded to `diff`. */
  diffOptions?: DiffOptions;
  /** Apply even when guardrails trip. Default false. */
  allowGuardrailOverride?: boolean;
  /** Max requests for the run (across all cycles). Default 1000. */
  requestBudget?: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the reconcile loop. For each scope in `scopes` and each cycle:
 *   1. fetchLive  2. buildDesired  3. diff  4. guardrails
 *   5a. dry-run: record the plan  5b. apply: apply each entry (if guardrails pass)
 *
 * Budget-aware (stops cleanly + records deferred work on exhaustion) and
 * fault-tolerant (a cycle that errors is recorded and the run continues).
 * Returns a structured `ReconcileResult`.
 */
export async function runReconcile<TClient, TConfig, TLive, TScope = unknown>(
  opts: RunReconcileOptions<TClient, TConfig, TLive, TScope>,
): Promise<ReconcileResult> {
  const {
    scopes,
    client,
    cycles,
    scope,
    mode = "dry-run",
    diff: diffFn,
    guardrails = (): GuardrailResult => ({ ok: true }),
    diffOptions = {},
    allowGuardrailOverride = false,
    requestBudget = 1000,
  } = opts;

  const budget = new MutableRateBudget(requestBudget);
  const cycleResults: CycleResult[] = [];
  const erroredCycles: CycleError[] = [];
  const deferred: DeferredWork = { skippedCycles: [], skippedEntries: [] };

  const scopeEntries = Object.entries(scopes);

  for (const cycle of cycles) {
    for (const [scopeId, scopeConfig] of scopeEntries) {
      if (budget.exhausted) {
        deferred.skippedCycles.push(`${cycle.name}@${scopeId}`);
        continue;
      }

      let live: TLive;
      try {
        live = await cycle.fetchLive(client, scopeId, scope as TScope, budget);
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          deferred.skippedCycles.push(`${cycle.name}@${scopeId}`);
          continue;
        }
        erroredCycles.push({ name: cycle.name, org: scopeId, stage: "fetchLive", error: errMsg(err) });
        continue;
      }

      let desired: TConfig;
      try {
        desired = cycle.buildDesired(scopeConfig, scopeId, scope as TScope);
      } catch (err) {
        erroredCycles.push({ name: cycle.name, org: scopeId, stage: "buildDesired", error: errMsg(err) });
        continue;
      }

      const changeSet = diffFn(scopeId, desired, live, diffOptions);
      // Stamp the cycle's governance verb onto entries that don't
      // carry one, so provider diffs stay verb-unaware.
      if (cycle.verb) {
        for (const e of changeSet.entries) e.verb ??= cycle.verb;
      }
      const guardrailResult = guardrails(changeSet, live);

      const counts = { create: 0, update: 0, delete: 0 };
      for (const e of changeSet.entries) counts[e.kind]++;

      const cycleResult: CycleResult = {
        name: cycle.name,
        verb: cycle.verb,
        org: scopeId,
        counts,
        guardrails: guardrailResult,
        applied: [],
        failed: [],
        plan: renderChangeSet(changeSet),
        guardrailBlocked: false,
      };

      if (mode === "dry-run") {
        cycleResults.push(cycleResult);
        continue;
      }

      if (!guardrailResult.ok && !allowGuardrailOverride) {
        cycleResult.guardrailBlocked = true;
        cycleResults.push(cycleResult);
        continue;
      }

      for (const entry of changeSet.entries) {
        if (budget.exhausted) {
          deferred.skippedEntries.push({ cycleName: cycle.name, entry });
          continue;
        }
        try {
          await cycle.apply(client, entry, scopeId, scope as TScope, budget);
          cycleResult.applied.push(entry);
        } catch (err) {
          if (err instanceof BudgetExhaustedError) {
            deferred.skippedEntries.push({ cycleName: cycle.name, entry });
            continue;
          }
          cycleResult.failed.push({ entry, error: errMsg(err) });
        }
      }

      cycleResults.push(cycleResult);
    }
  }

  const completed =
    deferred.skippedCycles.length === 0 &&
    deferred.skippedEntries.length === 0 &&
    erroredCycles.length === 0;

  return { mode, completed, cycles: cycleResults, errored: erroredCycles, deferred, budgetRemaining: budget.remaining };
}
