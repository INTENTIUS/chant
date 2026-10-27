/**
 * Drift rows (#4580): one row per object a plan found drifted, by address,
 * with its action and the object's real name, counted the way a product's
 * drift report counts. `./drift-record.ts` answers a different question (the
 * status of each instance the plan names), so it skips create rows, carries
 * no names and stays as it is.
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
 * `liveDrift`, `driftCount`, `driftNames`), so a row count here equals the
 * count its report gives for the same plan.
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

/** A refresh-only plan's `resource_drift`, one row per entry. */
function stockRows(doc: Json): TerraformDriftRow[] {
  const list = Array.isArray(doc.resource_drift) ? doc.resource_drift : [];
  return list.map((entry) => {
    const ch = isObject(entry) && isObject(entry.change) ? entry.change : {};
    const actions = Array.isArray(ch.actions) ? ch.actions.map(String) : [];
    return rowOf(entry, stockAction(actions), [ch.after, ch.before]);
  });
}

/** A live root's full plan, its changes read as drift. */
function liveRows(doc: Json): TerraformDriftRow[] {
  const list = Array.isArray(doc.resource_changes) ? doc.resource_changes : [];
  const out: TerraformDriftRow[] = [];
  for (const entry of list) {
    if (!isObject(entry) || entry.mode === "data") continue;
    const ch = isObject(entry.change) ? entry.change : {};
    const actions = Array.isArray(ch.actions) ? ch.actions.map(String) : [];
    if (actions.length === 0 || actions.every((a) => a === "no-op" || a === "read")) continue;
    const action = actions.length === 1 ? (FLIP[actions[0]!] ?? actions[0]!) : "update";
    const live = isObject(ch.before) ? ch.before : null;
    let code = isObject(ch.after) ? ch.after : null;
    // A value the plan knows only after the apply is not a difference: the live one stands for it.
    const unknown = isObject(ch.after_unknown) ? ch.after_unknown : {};
    if (code && live) code = { ...code, ...Object.fromEntries(Object.keys(unknown).filter((k) => unknown[k] === true && k in live).map((k) => [k, live[k]])) };
    out.push(rowOf(entry, action, [live, code]));
  }
  return out;
}

/**
 * The drift a plan (`show -json`, parsed) found, one row per drifted object
 * in the plan's order. Its length is the drift count.
 */
export function terraformPlanDriftRows(plan: unknown, options: TerraformPlanDriftRowsOptions = {}): TerraformDriftRow[] {
  if (!isObject(plan)) return [];
  return options.live ? liveRows(plan) : stockRows(plan);
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
