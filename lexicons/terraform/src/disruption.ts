/**
 * `classifyDisruption` for terraform (#5338): what applying a planned update
 * costs, from the plan's own `actions`.
 *
 * Terraform already says it. A `resource_changes[]` entry's
 * `change.actions` is `["update"]` for a change in place, `["create",
 * "delete"]` for a replacement created before the old one goes
 * (`create_before_destroy`), `["delete", "create"]` for one that deletes
 * first, and `["delete"]` for a removal. `replace_paths` names the
 * attributes that forced a replacement.
 *
 * | actions | disruption |
 * |---|---|
 * | `update` | `in-place` |
 * | `create`, `delete` | `replace` |
 * | `delete`, `create` | `destroy` |
 * | `delete` | `destroy` |
 *
 * The classifier answers through core's contract, from the attributes the
 * plan depth puts on each block (`planActions`, keyed by instance, and
 * `planReplacePaths`, see `./plan-observation.ts`). A block's verdict is its
 * most disruptive instance's. A query whose attributes carry no plan gets no
 * verdict, which core reads as `unknown`. {@link terraformDisruptionQueries}
 * builds the same queries straight from a `show -json` plan, one per
 * resource change, for a caller holding the plan rather than a read.
 *
 * The table itself is `terraformActionsDisruption` in `./change-set.ts`,
 * which the change set adapter reads too, so the two agree and the change
 * set bundle stays as light as it was.
 */
import type { Disruption, DisruptionQuery, DisruptionVerdict } from "@intentius/chant/lexicon";
import { terraformActionsDisruption } from "./change-set";
import { indexPlan } from "./plan-observation";

export { terraformActionsDisruption };

type Classified = Exclude<Disruption, "rolling" | "unknown">;

const RANK: Record<Classified, number> = { "in-place": 0, replace: 1, destroy: 2 };

const DETAIL: Record<Classified, string> = {
  "in-place": "the plan updates it in place",
  replace: "the plan creates a replacement, then deletes the old one",
  destroy: "the plan deletes it before anything replaces it",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One attribute off the query: its observed value, else the new value of a delta on it. */
function attribute(query: DisruptionQuery, key: string): unknown {
  if (query.attributes && key in query.attributes) return query.attributes[key];
  return query.deltas.find((d) => d.path === `attributes.${key}`)?.newValue;
}

/** One query's verdict, or undefined when its attributes carry no plan. */
export function terraformQueryVerdict(query: DisruptionQuery): DisruptionVerdict | undefined {
  const planActions = attribute(query, "planActions");
  if (!isRecord(planActions)) return undefined;
  let worst: Classified | undefined;
  for (const actions of Object.values(planActions)) {
    const d = terraformActionsDisruption(actions);
    if (d && (!worst || RANK[d] > RANK[worst])) worst = d;
  }
  if (!worst) return undefined;
  const paths = attribute(query, "planReplacePaths");
  const because = worst !== "in-place" && Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
  return {
    disruption: worst,
    ...(because.length > 0 ? { because } : {}),
    detail: because.length > 0 ? `${DETAIL[worst]}; ${because.join(", ")} forced it` : DETAIL[worst],
  };
}

/** `LexiconPlugin.classifyDisruption` for terraform. */
export function classifyTerraformDisruption(options: { environment: string; changes: DisruptionQuery[] }): Record<string, DisruptionVerdict> {
  const out: Record<string, DisruptionVerdict> = {};
  for (const query of options.changes) {
    const verdict = terraformQueryVerdict(query);
    if (verdict) out[query.name] = verdict;
  }
  return out;
}

/**
 * The queries a `show -json` plan holds: one per `resource_changes[]` entry
 * that changes something existing (an update, a replacement or a delete),
 * named by its address, with the plan's actions and replace paths as the
 * attributes the classifier reads.
 */
export function terraformDisruptionQueries(plan: unknown): DisruptionQuery[] {
  const index = indexPlan(plan);
  const out: DisruptionQuery[] = [];
  const raw = isRecord(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes.filter(isRecord) : [];
  for (const rc of raw) {
    const address = typeof rc.address === "string" ? rc.address : undefined;
    const change = address ? index.changes.get(address) : undefined;
    if (!address || !change || !terraformActionsDisruption(change.actions)) continue;
    out.push({
      name: address,
      ...(typeof rc.type === "string" ? { type: rc.type } : {}),
      deltas: [],
      attributes: {
        planActions: { [address]: change.actions },
        ...(change.replacePaths.length > 0 ? { planReplacePaths: change.replacePaths } : {}),
      },
    });
  }
  return out;
}
