/**
 * Drift-record adapters for the terraform family (#4451): a stock root's
 * state read and plan, and a choudoufu live root's `live-plan -json`,
 * `live-ls -json` and plan, each into `@intentius/chant/drift-record`
 * records.
 *
 * | source | read | status |
 * |---|---|---|
 * | `show -json` over state | `state` | in state: recorded. Declared and not in state: pending |
 * | `show -json` of a saved plan | `plan` | no `resource_drift` row: in-sync. Drift update: drifted with paths. Drift delete: missing. Create with no prior row: pending. Delete with no drift: undeclared |
 * | `live-plan -json` | `ownership` | `bound[]`: in-sync, owned by its `source`. `unowned[]` and `adoptable[]`: unclaimed. `ABSENT`: pending. Any other omission: not-observed. `foreign[]`: undeclared, foreign. `controller_held[]`: runtime |
 * | `live-ls -json` | `ownership` | `declared: false`: undeclared. A gap no live-plan row answers: not-observed |
 * | live-plan and a plan together | `plan` | bound with a planned update or replace: drifted with paths, the live-plan ownership kept |
 *
 * A state read never says in-sync or drifted: `driftRecord` refuses it.
 *
 * An omission keeps its token in `evidence.engineCode`, and so does the
 * `UNOWNED` omission that has no `unowned[]` row: chant reads it as
 * not-observed (`read-failed`), not as unclaimed, since nothing in the
 * document says what holds the identity.
 *
 * ## Values
 *
 * Attribute values come from `./plan-observation.ts`, which already replaced
 * every value the planner flagged, or that equals a flagged string, with
 * `(sensitive)`. Here a `(sensitive)` side makes the attribute `sensitive:
 * true` with neither value, and the record constructor's key-name pass runs
 * after. `before` is what was expected and `after` what the read found, so
 * a stock root's drift row reads state then refreshed object, and a live
 * root's planned update reads declared then live (the plan's after, then
 * its before).
 *
 * ## The import graph
 *
 * Like `./change-set.ts`, this imports chant's `drift-record` subpath, the
 * plan projection and the omission table, never the lexicon's entry point
 * or `./describe-resources.ts`, so it bundles without TypeScript, node's
 * process modules or the lint rules (#3421).
 */

import {
  driftRecord,
  placeDriftRecord,
  type DriftAdapterBase,
  type DriftAttribute,
  type DriftEvidence,
  type DriftOwnership,
  type DriftOwnershipBy,
  type DriftRecord,
} from "@intentius/chant/drift-record";
import { LIVE_PLAN_OMISSION_REASONS, readsAsCredentials } from "./live-plan-reasons";
import { blockAddressOf, indexPlan, KNOWN_AFTER_APPLY, SENSITIVE_VALUE, type PlanValueChange } from "./plan-observation";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byAddress = (a: DriftRecord, b: DriftRecord): number => byString(a.address, b.address);

/** True for an address inside a `data` block, which has no drift. */
function isDataAddress(address: string): boolean {
  return /(^|\.)data\./.test(blockAddressOf(address));
}

function common(input: DriftAdapterBase, engine: DriftRecord["engine"], read: DriftRecord["read"], address: string) {
  return {
    member: input.member,
    engine,
    address,
    ...placeDriftRecord(input, engine, address),
    observedAt: input.observedAt,
    read,
    ...(input.fellBackFrom !== undefined ? { fellBackFrom: input.fellBackFrom } : {}),
  };
}

/** One projected plan change as a drift attribute. `swap` reads the change's after as expected. */
function attributeOf(change: PlanValueChange, swap: boolean): DriftAttribute {
  const path = change.path;
  if (change.before === SENSITIVE_VALUE || change.after === SENSITIVE_VALUE) return { path, sensitive: true };
  const expected = swap ? change.after : change.before;
  const found = swap ? change.before : change.after;
  return {
    path,
    ...(expected !== null && expected !== undefined && expected !== KNOWN_AFTER_APPLY ? { before: expected } : {}),
    ...(found !== null && found !== undefined && found !== KNOWN_AFTER_APPLY ? { after: found } : {}),
  };
}

// ── state ──────────────────────────────────────────────────────────────────────

/** Every managed resource row of a `show -json` state document: address and type. */
function stateRows(showJson: unknown): Map<string, { type?: string }> {
  const rows = new Map<string, { type?: string }>();
  const walk = (module: unknown, prefix: string): void => {
    const node = isObject(module) ? module : {};
    for (const entry of asArray(node.resources)) {
      if (!isObject(entry)) continue;
      const raw = asString(entry.address);
      if (!raw || entry.mode === "data") continue;
      const address = prefix && !raw.startsWith(`${prefix}.`) ? `${prefix}.${raw}` : raw;
      rows.set(address, asString(entry.type) ? { type: asString(entry.type) } : {});
    }
    for (const child of asArray(node.child_modules)) {
      if (isObject(child)) walk(child, asString(child.address) ?? prefix);
    }
  };
  const doc = isObject(showJson) ? showJson : {};
  walk(isObject(doc.values) ? doc.values.root_module : undefined, "");
  return rows;
}

export interface TerraformStateDriftInput extends DriftAdapterBase {
  engine?: "terraform" | "tofu";
  /** `terraform show -json` over the root's state, parsed. Absent when the read failed. */
  state?: unknown;
  /**
   * The root's declared resource blocks, by terraform address
   * (`module.cdn.null_resource.edge`). A block with no instance in state is
   * pending. Omit to report only what state holds.
   */
  declared?: readonly string[];
  /** The read failed: every declared block is not-observed with this reason. */
  failed?: { reason: "read-failed" | "no-credentials" | "no-binding"; detail?: string };
}

/**
 * A stock root's records from its state: every managed instance in state is
 * recorded, every declared block with no instance there is pending, and a
 * failed read makes every declared block not-observed. Never in-sync or
 * drifted: state says what the last apply recorded, not what the account
 * holds.
 */
export function terraformStateDriftRecords(input: TerraformStateDriftInput): DriftRecord[] {
  const engine = input.engine ?? "terraform";
  const evidence: DriftEvidence = { tool: engine, ...(input.version ? { version: input.version } : {}), command: `${engine} show -json` };
  if (input.failed) {
    return (input.declared ?? [])
      .map((address) =>
        driftRecord({
          ...common(input, engine, "state", address),
          status: "not-observed",
          unobserved: { reason: input.failed!.reason, ...(input.failed!.detail ? { detail: input.failed!.detail } : {}) },
          evidence,
        }),
      )
      .sort(byAddress);
  }
  const rows = stateRows(input.state);
  const out: DriftRecord[] = [];
  for (const [address, row] of rows) {
    out.push(driftRecord({ ...common(input, engine, "state", address), ...(row.type ? { resourceType: row.type } : {}), status: "recorded", ownership: { verdict: "owned", by: "state" }, evidence }));
  }
  const blocks = new Set([...rows.keys()].map(blockAddressOf));
  for (const address of input.declared ?? []) {
    if (blocks.has(address) || rows.has(address)) continue;
    out.push(driftRecord({ ...common(input, engine, "state", address), status: "pending", evidence }));
  }
  return out.sort(byAddress);
}

// ── plan ───────────────────────────────────────────────────────────────────────

export interface TerraformPlanDriftInput extends DriftAdapterBase {
  engine?: "terraform" | "tofu";
  /** `terraform show -json <planfile>`, parsed. */
  plan: unknown;
}

/**
 * A stock root's records from a saved plan's `show -json`, one per managed
 * instance the plan names. A `resource_drift[]` row decides: update is
 * drifted with its paths (before is state, after the refreshed object),
 * delete is missing. With no drift row, a create with no prior-state row is
 * pending, a delete or forget the configuration no longer declares is
 * undeclared, and anything else is in-sync, since a planned change from
 * configuration is the change set's to show and not drift.
 */
export function terraformPlanDriftRecords(input: TerraformPlanDriftInput): DriftRecord[] {
  const engine = input.engine ?? "terraform";
  const doc = isObject(input.plan) ? input.plan : {};
  const version = input.version ?? asString(doc.terraform_version);
  const evidence: DriftEvidence = { tool: engine, ...(version ? { version } : {}), command: `${engine} show -json` };
  const index = indexPlan(input.plan);
  const prior = stateRows({ values: isObject(index.priorState) ? index.priorState.values : undefined });
  const types = new Map<string, string>();
  for (const entry of asArray(doc.resource_changes)) {
    if (isObject(entry) && asString(entry.address) && asString(entry.type)) types.set(entry.address as string, entry.type as string);
  }
  const addresses = [...new Set([...index.changes.keys(), ...index.drift.keys()])].filter((a) => !isDataAddress(a)).sort(byString);
  return addresses.map((address) => {
    const type = types.get(address) ?? prior.get(address)?.type;
    const at = { ...common(input, engine, "plan", address), ...(type ? { resourceType: type } : {}), evidence };
    const drift = index.drift.get(address);
    if (drift?.actions.includes("delete")) return driftRecord({ ...at, status: "missing" });
    if (drift && drift.actions.includes("update")) {
      const attributes = drift.changes.map((c) => attributeOf(c, false));
      return driftRecord({ ...at, status: "drifted", ...(attributes.length > 0 ? { attributes } : {}) });
    }
    const actions = index.changes.get(address)?.actions ?? [];
    if (actions.length === 1 && actions[0] === "create" && !prior.has(address)) return driftRecord({ ...at, status: "pending" });
    if (actions.length === 1 && (actions[0] === "delete" || actions[0] === "forget")) return driftRecord({ ...at, status: "undeclared" });
    return driftRecord({ ...at, status: "in-sync" });
  });
}

// ── choudoufu live-plan ────────────────────────────────────────────────────────

const BOUND_SOURCES: readonly DriftOwnershipBy[] = ["marker", "record", "derived", "cache"];

export interface ChoudoufuLivePlanDriftInput extends DriftAdapterBase {
  /** `choudoufu live-plan -json`, parsed. */
  livePlan: unknown;
}

/**
 * A live root's records from `live-plan -json`, read `ownership`, one per
 * address the document names.
 *
 * - `bound[]`: in-sync, `owned` by the row's `source`, the marker on the
 *   object exactly when the source is `marker`.
 * - `unowned[]`: unclaimed, `adoptable` when the row carries the adopting
 *   tag values and `foreign` otherwise, with the estate it does carry. It
 *   answers before the paired `UNOWNED` omission.
 * - `adoptable[]`: unclaimed, `adoptable`, the paired omission's token kept.
 * - an `ABSENT` omission: pending.
 * - any other omission, `UNOWNED` with no row included: not-observed with
 *   the reason `LIVE_PLAN_OMISSION_REASONS` gives (`VERIFIED_NOT_IMPORTABLE`
 *   read-failed, `OUT_OF_SCOPE` filtered), a credentials failure named as
 *   such.
 * - `foreign[]`: undeclared, `foreign`, addressed by its identity.
 * - `controller_held[]`: runtime, `foreign`, held by its controller,
 *   addressed by the marker's address when it has one and its identity
 *   otherwise.
 */
export function choudoufuLivePlanDriftRecords(input: ChoudoufuLivePlanDriftInput): DriftRecord[] {
  const doc = isObject(input.livePlan) ? input.livePlan : {};
  const version = input.version ?? asString(doc.choudoufu_version);
  const evidence = (engineCode?: string): DriftEvidence => ({
    tool: "choudoufu",
    ...(version ? { version } : {}),
    command: "choudoufu live-plan -json",
    ...(engineCode ? { engineCode } : {}),
  });
  const out = new Map<string, DriftRecord>();
  const put = (address: string, record: Omit<DriftRecord, keyof ReturnType<typeof common>>) => {
    if (!out.has(address)) out.set(address, driftRecord({ ...common(input, "choudoufu", "ownership", address), ...record }));
  };
  const typed = (row: Json) => (asString(row.type) ? { resourceType: asString(row.type)! } : {});

  const omissions = new Map<string, { reason: string; detail: string }>();
  for (const row of asArray(doc.omissions).filter(isObject)) {
    const addr = asString(row.addr);
    if (addr) omissions.set(addr, { reason: asString(row.reason) ?? "", detail: asString(row.detail) ?? "" });
  }

  for (const row of asArray(doc.unowned).filter(isObject)) {
    const addr = asString(row.addr);
    if (!addr) continue;
    const heldBy = asString(row.tofu_estate);
    const adopt = asString(row.adopt_tofu_address);
    const ownership: DriftOwnership = adopt || asString(row.adopt_tofu_estate)
      ? { verdict: "adoptable", markerOnObject: heldBy !== undefined, ...(heldBy ? { by: "marker", ownedBy: heldBy } : {}), ...(adopt ? { adopt } : {}) }
      : { verdict: "foreign", markerOnObject: heldBy !== undefined, ...(heldBy ? { by: "marker", ownedBy: heldBy } : {}) };
    put(addr, { ...typed(row), status: "unclaimed", ownership, evidence: evidence(omissions.get(addr)?.reason || "UNOWNED") });
  }

  for (const row of asArray(doc.bound).filter(isObject)) {
    const addr = asString(row.addr);
    if (!addr) continue;
    const source = asString(row.source);
    const by = BOUND_SOURCES.find((s) => s === source);
    put(addr, { ...typed(row), status: "in-sync", ownership: { verdict: "owned", ...(by ? { by } : {}), markerOnObject: source === "marker" }, evidence: evidence() });
  }

  for (const row of asArray(doc.adoptable).filter(isObject)) {
    const addr = asString(row.addr);
    if (!addr) continue;
    const adopt = asString(row.adopt_tofu_address);
    put(addr, {
      ...typed(row),
      status: "unclaimed",
      ownership: { verdict: "adoptable", markerOnObject: false, ...(adopt ? { adopt } : {}) },
      evidence: evidence(omissions.get(addr)?.reason),
    });
  }

  for (const [addr, row] of omissions) {
    const mapped = LIVE_PLAN_OMISSION_REASONS[row.reason] ?? "read-failed";
    if (mapped === "absent") {
      put(addr, { status: "pending", evidence: evidence(row.reason) });
      continue;
    }
    const reason = mapped === "read-failed" && readsAsCredentials(row.detail) ? "no-credentials" : mapped;
    put(addr, {
      status: "not-observed",
      unobserved: { reason, ...(row.detail ? { detail: row.detail } : {}) },
      evidence: evidence(row.reason || undefined),
    });
  }

  for (const row of asArray(doc.foreign).filter(isObject)) {
    const identity = asString(row.identity);
    if (!identity) continue;
    const heldBy = asString(row.tofu_estate);
    put(identity, {
      ...typed(row),
      status: "undeclared",
      ownership: { verdict: "foreign", markerOnObject: heldBy !== undefined, ...(heldBy ? { by: "marker", ownedBy: heldBy } : {}) },
      evidence: evidence(),
    });
  }

  for (const row of asArray(doc.controller_held).filter(isObject)) {
    const address = asString(row.addr) ?? asString(row.identity);
    if (!address) continue;
    const heldBy = asString(row.held_by) ?? asString(row.controller);
    put(address, {
      ...typed(row),
      status: "runtime",
      ownership: { verdict: "foreign", by: "label", ...(heldBy ? { ownedBy: heldBy } : {}) },
      evidence: evidence(asString(row.controller)),
    });
  }

  return [...out.values()].sort(byAddress);
}

// ── choudoufu live-ls ──────────────────────────────────────────────────────────

export interface ChoudoufuLiveLsDriftInput extends DriftAdapterBase {
  /** `choudoufu live-ls -json`, parsed. */
  liveLs: unknown;
  /**
   * Addresses another read already answered (the live-plan records'), so a
   * gap on one of them is not reported: the gap says the listing cannot
   * reach the instance, and live-plan did.
   */
  answered?: Iterable<string>;
}

/**
 * A live root's records from `live-ls -json`, read `ownership`. An item with
 * `declared: false` is undeclared, addressed by its marker's address or else
 * its identity: `owned` when its marker names this estate, held by the
 * controller (runtime) when it has `held_by`, `foreign` when it names
 * another estate. A declared item is live-plan's to answer and is left out.
 * A gap is not-observed `unsupported-kind` with its rung as the token,
 * unless `answered` holds its address.
 */
export function choudoufuLiveLsDriftRecords(input: ChoudoufuLiveLsDriftInput): DriftRecord[] {
  const doc = isObject(input.liveLs) ? input.liveLs : {};
  const estate = asString(doc.estate);
  const answered = new Set(input.answered ?? []);
  const evidence = (engineCode?: string): DriftEvidence => ({
    tool: "choudoufu",
    ...(input.version ? { version: input.version } : {}),
    command: "choudoufu live-ls -json",
    ...(engineCode ? { engineCode } : {}),
  });
  const out = new Map<string, DriftRecord>();
  for (const row of asArray(doc.items).filter(isObject)) {
    if (row.declared !== false) continue;
    const address = asString(row.address) ?? asString(row.id);
    if (!address || out.has(address)) continue;
    const tags = isObject(row.tags) ? row.tags : {};
    const marker = asString(tags["tofu-estate"]);
    const heldBy = asString(row.held_by);
    const ownership: DriftOwnership = heldBy
      ? { verdict: "foreign", by: "label", ownedBy: heldBy }
      : marker === undefined
        ? { verdict: "unknown" }
        : marker === estate
          ? { verdict: "owned", by: "marker", markerOnObject: true }
          : { verdict: "foreign", by: "marker", markerOnObject: true, ownedBy: marker };
    out.set(
      address,
      driftRecord({
        ...common(input, "choudoufu", "ownership", address),
        ...(asString(row.type) ? { resourceType: asString(row.type)! } : {}),
        status: heldBy ? "runtime" : "undeclared",
        ownership,
        evidence: evidence(),
      }),
    );
  }
  for (const row of asArray(doc.gaps).filter(isObject)) {
    const address = asString(row.address);
    if (!address || answered.has(address) || out.has(address)) continue;
    out.set(
      address,
      driftRecord({
        ...common(input, "choudoufu", "ownership", address),
        ...(asString(row.type) ? { resourceType: asString(row.type)! } : {}),
        status: "not-observed",
        unobserved: { reason: "unsupported-kind", ...(asString(row.detail) ? { detail: asString(row.detail)! } : {}) },
        evidence: evidence(asString(row.rung)),
      }),
    );
  }
  return [...out.values()].sort(byAddress);
}

/** live-plan's records, then live-ls's undeclared items and the gaps live-plan did not answer. */
export function choudoufuLiveDriftRecords(input: DriftAdapterBase & { livePlan: unknown; liveLs?: unknown }): DriftRecord[] {
  const plan = choudoufuLivePlanDriftRecords(input);
  if (input.liveLs === undefined) return plan;
  const answered = new Set(plan.map((r) => r.address));
  const ls = choudoufuLiveLsDriftRecords({ ...input, liveLs: input.liveLs, answered }).filter((r) => !answered.has(r.address));
  return [...plan, ...ls].sort(byAddress);
}

// ── choudoufu live+plan ────────────────────────────────────────────────────────

export interface ChoudoufuLivePlusPlanDriftInput extends DriftAdapterBase {
  /** `choudoufu live-plan -json`, parsed. */
  livePlan: unknown;
  /** `choudoufu show -json <planfile>` of the same root, parsed. */
  plan: unknown;
  /** `choudoufu live-ls -json`, parsed, when it was read too. */
  liveLs?: unknown;
}

/**
 * A live root at the plan depth. Every bound instance is read `plan`: a
 * planned update or replace is drifted with the plan's paths, since a live
 * root's prior state is the account itself, and anything else is in-sync.
 * Its ownership facet is live-plan's. Every other address keeps its
 * live-plan or live-ls record, read `ownership`, because the plan does not
 * say who holds it.
 */
export function choudoufuLivePlusPlanDriftRecords(input: ChoudoufuLivePlusPlanDriftInput): DriftRecord[] {
  const live = choudoufuLiveDriftRecords(input);
  const index = indexPlan(input.plan);
  const doc = isObject(input.plan) ? input.plan : {};
  const version = input.version ?? asString(doc.terraform_version);
  return live
    .map((r) => {
      if (r.read !== "ownership" || r.status !== "in-sync" || r.ownership?.verdict !== "owned") return r;
      const change = index.changes.get(r.address);
      const actions = change?.actions ?? [];
      const moves = actions.includes("update") || (actions.includes("create") && actions.includes("delete"));
      const attributes = moves ? change!.changes.map((c) => attributeOf(c, true)) : [];
      return driftRecord({
        ...r,
        read: "plan",
        status: moves ? "drifted" : "in-sync",
        ...(attributes.length > 0 ? { attributes } : {}),
        evidence: { tool: "choudoufu", ...(version ? { version } : {}), command: "choudoufu live-plan -json, choudoufu show -json" },
      });
    })
    .sort(byAddress);
}
