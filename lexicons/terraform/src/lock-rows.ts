/**
 * The terraform lexicon's lock grain (#4552) and the rows a choudoufu apply
 * holds on the resource grain, in terragucci's format (`planRows` in
 * terragucci's `apply-rows.ts` at 18f6431), unchanged:
 *
 * - `estate <estate> <address>` for every resource instance the apply acts
 *   on (a create, update, delete, replace or forget), or `root <root>
 *   <address>` when the root has no estate;
 * - the same for `previous_address` on a moved instance;
 * - `object <id>` for anything but a create, from the object's id before,
 *   so two estates that meet on one object meet on its row.
 *
 * Data reads and no-ops hold nothing.
 *
 * The grain: `resource` for choudoufu, which keeps one record per resource,
 * writes each conditionally and refuses a plan one of whose changes moved;
 * `target` (the root, or the Terragrunt unit) for Terraform, tofu and
 * Terragrunt, whose state is one file the backend's lock keeps whole. Those
 * three refuse `resource` by name, since nothing in their state is per
 * resource.
 */
import type { ChangeSetPart, ChangeSetPlanner } from "@intentius/chant/change-set";
import { objectRowKey, sortedLockRows, type LockGrain, type LockRow } from "@intentius/chant/lifecycle/lock-rows";

const CHANGING = new Set(["create", "update", "delete", "forget"]);

/** The scope a root's rows are keyed in: its estate, else its path. */
function rowScope(root: string, estate: string | undefined): string {
  return estate ? `estate ${estate}` : `root ${root}`;
}

/** The rows a plan's changes key, from `show -json`'s `resource_changes` (terragucci's `planRows`). */
export function terraformLockRows(root: string, estate: string | undefined, plan: unknown): LockRow[] {
  const scope = rowScope(root, estate);
  const rows: LockRow[] = [];
  const changes = (plan as { resource_changes?: unknown[] } | undefined)?.resource_changes ?? [];
  for (const c of changes as Array<Record<string, any>>) {
    if (c?.mode === "data" || typeof c?.address !== "string") continue;
    const actions: string[] = Array.isArray(c.change?.actions) ? c.change.actions : [];
    if (!actions.some((a) => CHANGING.has(a))) continue;
    const address = c.address as string;
    rows.push({ key: `${scope} ${address}`, target: root, address });
    if (typeof c.previous_address === "string" && c.previous_address !== address) rows.push({ key: `${scope} ${c.previous_address}`, target: root, address });
    // The live object an update or a delete acts on: two estates that meet on one object meet here.
    const id = c.change?.before?.id;
    if (actions.some((a) => a !== "create") && (typeof id === "string" || typeof id === "number") && String(id) !== "") rows.push({ key: objectRowKey(String(id)), target: root, address });
  }
  return sortedLockRows(rows);
}

/**
 * The rows from a member's change-set part, when the plan document is not
 * at hand: the same keys, less the previous address of a moved instance,
 * which the part does not carry. The part's `scope` is the estate.
 */
export function terraformLockRowsFromPart(root: string, part: ChangeSetPart): LockRow[] {
  const scope = rowScope(root, part.member.planner === "choudoufu" ? part.member.scope : undefined);
  const rows: LockRow[] = [];
  for (const e of part.entries) {
    if (e.action === "no-op" || e.action === "read") continue;
    rows.push({ key: `${scope} ${e.address}`, target: root, address: e.address });
    if (e.action !== "create" && e.id) rows.push({ key: objectRowKey(e.id), target: root, address: e.address });
  }
  return sortedLockRows(rows);
}

/** Whether a binary's name is Terragrunt's. */
function isTerragrunt(binary: string | undefined): boolean {
  return /^terragrunt(\.exe)?$/.test((binary ?? "").split(/[\\/]/).pop() ?? "");
}

/** The grain a root takes by default: `resource` under choudoufu, `target` under every other binary. */
export function terraformDefaultLockGrain(planner: ChangeSetPlanner | undefined): LockGrain {
  return planner === "choudoufu" ? "resource" : "target";
}

/** Why a root cannot take `grain`, by engine name, or undefined when it can. */
export function terraformLockGrainRefusal(grain: LockGrain, planner: ChangeSetPlanner | undefined, binary?: string): string | undefined {
  if (grain !== "resource" || planner === "choudoufu") return undefined;
  const engine = isTerragrunt(binary) ? "Terragrunt" : planner === "tofu" ? "tofu" : "Terraform";
  return `${engine} keeps a root's state in one file that its backend's lock keeps whole, so nothing in it is per resource; the resource grain needs choudoufu (ci.lockGrain: target)`;
}
