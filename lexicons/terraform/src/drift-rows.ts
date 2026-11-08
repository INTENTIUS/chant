/**
 * Drift rows (#4580): one row per object a plan found drifted, by address,
 * with its action and the object's real name, counted the way a product's
 * drift report counts. `./drift-record.ts` answers a different question (the
 * status of each instance the plan names, redacted), so it skips create
 * rows and carries no names.
 *
 * A stock root's refresh-only plan reports drift as `resource_drift`, and
 * every entry there is one row, data blocks and creates included. A full
 * plan of a root under live resource markers (`live: true`) reads drift from
 * `resource_changes` instead, seen from the other side: a create there is an
 * object that no longer exists (delete), a delete one that exists outside
 * the code (create), a replacement or any other pair of actions an update.
 * Data blocks, no-op and read entries are not drift.
 *
 * These are terragucci's rules (packages/terragucci/src/report/drift.ts:
 * `driftPlan`, `liveDrift`, `driftCount`, `driftNames`), so a row count here
 * equals the count its report gives for the same plan.
 *
 * Behind every row is a whole change (#4812): the plan's entry for the
 * object, shaped as a `resource_changes[]` entry with its actions, full
 * before and after and their masks (`terraformPlanDriftChanges`). A drift
 * report is a plan report over those changes: `terraformDriftPlan` puts a
 * refresh-only plan's drift in place of its changes, and
 * `terraformLivePlanDrift` reads a live root's full plan as drift.
 *
 * A row carries no attribute values. Its `name` is the first non-empty
 * string among `name`, `id`, `bucket`, `function_name` and `arn`, read from
 * the object as found and then as the code has it; a deleted object has no
 * other place its name survives.
 *
 * The module imports nothing, so a product can load it behind a
 * feature-detect without pulling the lexicon's entry point.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** One drifted object. */
export interface TerraformDriftRow {
  /** The resource address, `""` when the plan's entry has none. */
  address: string;
  /**
   * What happened outside the code: `update`, `delete` (the object is gone),
   * `create` (an object exists that state or code does not hold), or on a
   * stock root whatever single action the plan's entry names. On a stock
   * root a delete-and-create pair is `replace`, and any other pair `update`.
   */
  action: string;
  /** The resource type, when the entry names one. */
  type?: string;
  /** The object's real name, by the rule in this module's header. */
  name?: string;
}

export interface TerraformPlanDriftRowsOptions {
  /**
   * The plan is a full plan of a root under live resource markers, whose
   * changes are its drift. Default false: a refresh-only plan's
   * `resource_drift`.
   */
  live?: boolean;
}

const FLIP: Record<string, string> = { create: "delete", delete: "create" };
const NAME_KEYS = ["name", "id", "bucket", "function_name", "arn"] as const;

function nameOf(values: readonly unknown[]): string | undefined {
  const objects = values.filter(isObject);
  for (const key of NAME_KEYS) {
    const v = objects.map((x) => x[key]).find((x) => typeof x === "string" && x !== "");
    if (typeof v === "string") return v;
  }
  return undefined;
}

function rowOf(entry: unknown, action: string, values: readonly unknown[]): TerraformDriftRow {
  const r = isObject(entry) ? entry : {};
  const name = nameOf(values);
  return {
    address: typeof r.address === "string" ? r.address : "",
    action,
    ...(typeof r.type === "string" && r.type !== "" ? { type: r.type } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

function stockAction(actions: readonly string[]): string {
  if (actions.length === 1) return actions[0]!;
  if (actions.length === 2 && actions.includes("delete") && actions.includes("create")) return "replace";
  return "update";
}

/** One row per whole change. */
function rowsOf(changes: readonly unknown[]): TerraformDriftRow[] {
  return changes.map((entry) => {
    const ch = isObject(entry) && isObject(entry.change) ? entry.change : {};
    const actions = Array.isArray(ch.actions) ? ch.actions.map(String) : [];
    return rowOf(entry, stockAction(actions), [ch.after, ch.before]);
  });
}

/**
 * A live root's full plan, its changes read as drift: each one the plan
 * would make, seen from the other side, as terragucci's `liveDrift` builds
 * it. The code's value is before and the live value after, the masks swap
 * with them, and a value the plan knows only after the apply takes the live
 * one, since it is not a difference.
 */
function liveChanges(doc: Json): Json[] {
  const list = Array.isArray(doc.resource_changes) ? doc.resource_changes : [];
  const out: Json[] = [];
  for (const entry of list) {
    if (!isObject(entry) || entry.mode === "data") continue;
    const ch = isObject(entry.change) ? entry.change : {};
    const actions = Array.isArray(ch.actions) ? ch.actions.map(String) : [];
    if (actions.length === 0 || actions.every((a) => a === "no-op" || a === "read")) continue;
    const action = actions.length === 1 ? (FLIP[actions[0]!] ?? actions[0]!) : "update";
    const live = (ch.before ?? null) as unknown;
    let code = (ch.after ?? null) as unknown;
    const unknown = isObject(ch.after_unknown) ? ch.after_unknown : {};
    if (isObject(code) && isObject(live)) {
      const known = live;
      code = { ...code, ...Object.fromEntries(Object.keys(unknown).filter((k) => unknown[k] === true && k in known).map((k) => [k, known[k]])) };
    }
    out.push({
      ...entry,
      change: { actions: [action], before: code, after: live, before_sensitive: ch.after_sensitive ?? false, after_sensitive: ch.before_sensitive ?? false },
    });
  }
  return out;
}

/** A refresh-only plan's `resource_drift`, each entry as the plan has it. */
function stockChanges(doc: Json): Json[] {
  return (Array.isArray(doc.resource_drift) ? [...doc.resource_drift] : []) as Json[];
}

/**
 * The drift a plan (`show -json`, parsed) found as whole changes (#4812),
 * one per drifted object in the plan's order, each shaped as a
 * `resource_changes[]` entry: `address`, `mode`, `type`, `name`,
 * `module_address`, `index`, `deposed` and `provider_name` as the plan has
 * them, and `change` with its actions, its full before and after, and their
 * masks. A stock root's are its `resource_drift` entries unchanged. A live
 * root's are its full plan's changes seen from the other side: a create
 * there is a `delete` (the object no longer exists), a delete a `create`
 * (an object exists outside the code), any pair of actions an `update`, the
 * code's value before and the live one after, the sensitive masks swapped
 * with them and an unknown value replaced by the live one.
 *
 * Values are not redacted: a change carries what the plan carries, masks
 * included, for a report that renders the plan. A drift record
 * (`./drift-record.ts`) is the redacted read.
 *
 * Its length is the drift count, and `terraformPlanDriftRows` is one row
 * per entry. A malformed `resource_drift` entry that is not an object is
 * passed on as the plan has it, and its row has the address `""`.
 */
export function terraformPlanDriftChanges(plan: unknown, options: TerraformPlanDriftRowsOptions = {}): Record<string, unknown>[] {
  if (!isObject(plan)) return [];
  return options.live ? liveChanges(plan) : stockChanges(plan);
}

/**
 * A refresh-only plan as its drift report reads it: the drift found in place
 * of the changes proposed, so the report is built from the same JSON as a
 * plan's and code waiting on the default branch never shows in it.
 * `resource_changes` becomes `terraformPlanDriftChanges(plan)`; the rest of
 * the document is kept. Anything not an object is returned as it is.
 */
export function terraformDriftPlan(plan: unknown): unknown {
  if (!isObject(plan)) return plan;
  return { ...plan, resource_changes: terraformPlanDriftChanges(plan) };
}

/**
 * A full plan of a root under live resource markers, as drift: its
 * `resource_drift` becomes `terraformPlanDriftChanges(plan, { live: true })`
 * and the rest of the document is kept, so it reads as a refresh-only plan
 * would (`terraformDriftPlan`, and every function here without `live`).
 * Anything not an object is returned as it is.
 */
export function terraformLivePlanDrift(plan: unknown): unknown {
  if (!isObject(plan)) return plan;
  return { ...plan, resource_drift: terraformPlanDriftChanges(plan, { live: true }) };
}

/**
 * The drift a plan (`show -json`, parsed) found, one row per drifted object
 * in the plan's order. Its length is the drift count.
 */
export function terraformPlanDriftRows(plan: unknown, options: TerraformPlanDriftRowsOptions = {}): TerraformDriftRow[] {
  return rowsOf(terraformPlanDriftChanges(plan, options));
}

/** How many objects a plan found drifted: `terraformPlanDriftRows(plan, options).length`. */
export function terraformPlanDriftCount(plan: unknown, options: TerraformPlanDriftRowsOptions = {}): number {
  return terraformPlanDriftRows(plan, options).length;
}

/** Each drifted object's real name by address, for the rows that have one. */
export function terraformPlanDriftNames(plan: unknown, options: TerraformPlanDriftRowsOptions = {}): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of terraformPlanDriftRows(plan, options)) if (row.name !== undefined) out.set(row.address, row.name);
  return out;
}
