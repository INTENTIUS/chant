/**
 * The composed plan cut back into one plan per member (chant#4442, epic
 * #4419): each member's part of the composed root's `show -json`, as if the
 * member's root had planned alone, and from it the member's change-set part,
 * planned outputs, plan shape and reads of other members, so the change set,
 * the report, policy and behold see each component and not one composed
 * root.
 *
 * Lifted from terragucci's `packages/terragucci/src/compose.ts` at c493e0e
 * (`slicePlan`, `sliceText`, `planCounts`, `composedReportReads`). Addresses
 * are stripped by `./module-address`, which `chant terraform report` uses
 * too. The outputs are `<m>__<name>` in the composed root, as #4441 writes
 * them and terragucci did.
 */

import type { ChangeSetPlanner, ChangeSetPart } from "@intentius/chant/change-set";
import type { CapabilityPlan, PlannedOutputs } from "@intentius/chant/components/capability";
import type { PlanShape } from "@intentius/chant/components/covered-round";
import type { Composition, ComposedRead } from "../compose";
import { terraformChangeSetPart } from "../change-set";
import { terraformPlannedOutputs } from "../components/capability-plugin";
import { terraformPlanShape } from "../plan-shape";
import { rootTexts } from "./hcl";
import { inModule, moduleChanges, stripModule, topModule } from "./module-address";
import { READ_VAR_PREFIX } from "./root";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The outputs of module `m` among a composed root's, by their own names. */
function moduleOutputs(outputs: unknown, m: string): Json {
  if (!isObj(outputs)) return {};
  return Object.fromEntries(Object.entries(outputs).filter(([k]) => k.startsWith(`${m}__`)).map(([k, v]) => [k.slice(m.length + 2), v]));
}

/** A module's part of `planned_values` or `prior_state.values`: its child module as the root module, addresses unprefixed. */
function moduleValues(values: unknown, m: string, outputs: Json): Json | undefined {
  if (!isObj(values)) return undefined;
  const root = isObj(values.root_module) ? values.root_module : {};
  const child = (Array.isArray(root.child_modules) ? root.child_modules : []).find((x) => isObj(x) && x.address === `module.${m}`) as Json | undefined;
  const strip = (mod: Json): Json => ({
    ...mod,
    ...(Array.isArray(mod.resources) ? { resources: mod.resources.map((x) => (isObj(x) ? { ...x, address: stripModule(String(x.address)) } : x)) } : {}),
    ...(Array.isArray(mod.child_modules) ? { child_modules: mod.child_modules.map((x) => (isObj(x) ? strip({ ...x, address: stripModule(String(x.address)) }) : x)) } : {}),
  });
  const { address: _a, ...rest } = child ? strip(child) : { address: undefined };
  return { ...values, outputs, root_module: rest };
}

/**
 * One member's part of the composed plan's `show -json`, as if it had
 * planned alone: its resource changes and drift with `module.<m>.` taken off,
 * its outputs by their own names, its planned values, prior state and
 * configuration as the root module. `checks` and `variables` (the composed
 * root's) are left out.
 */
export function slicePlan(plan: unknown, m: string): unknown {
  if (!isObj(plan)) return plan;
  const out: Json = { ...plan };
  if (Array.isArray(plan.resource_changes)) out.resource_changes = moduleChanges(plan.resource_changes, m);
  if (Array.isArray(plan.resource_drift)) out.resource_drift = moduleChanges(plan.resource_drift, m);
  if (isObj(plan.output_changes)) out.output_changes = moduleOutputs(plan.output_changes, m);
  if (isObj(plan.planned_values)) out.planned_values = moduleValues(plan.planned_values, m, moduleOutputs(plan.planned_values.outputs, m));
  if (isObj(plan.prior_state)) {
    const values = isObj(plan.prior_state.values) ? plan.prior_state.values : undefined;
    out.prior_state = { ...plan.prior_state, ...(values ? { values: moduleValues(values, m, moduleOutputs(values.outputs, m)) } : {}) };
  }
  if (isObj(plan.configuration)) {
    const root = isObj(plan.configuration.root_module) ? plan.configuration.root_module : {};
    const call = isObj(root.module_calls) && isObj(root.module_calls[m]) ? (root.module_calls[m] as Json) : undefined;
    const pc = isObj(plan.configuration.provider_config) ? plan.configuration.provider_config : {};
    out.configuration = {
      ...plan.configuration,
      provider_config: Object.fromEntries(
        Object.entries(pc).flatMap(([k, v]) =>
          k.startsWith(`module.${m}:`) ? [[k.slice(`module.${m}:`.length), isObj(v) ? { ...v, module_address: undefined } : v]] : k.includes(":") ? [] : [[k, v]],
        ),
      ),
      root_module: isObj(call?.module) ? call!.module : {},
    };
  }
  if (Array.isArray(plan.relevant_attributes)) {
    out.relevant_attributes = plan.relevant_attributes
      .filter((x) => isObj(x) && inModule(String(x.resource), m) && String(x.resource) !== `module.${m}`)
      .map((x) => ({ ...(x as Json), resource: stripModule(String((x as Json).resource)) }));
  }
  delete out.checks;
  delete out.variables;
  return out;
}

/** A plan's counts as the binary's `Plan:` line gives them, and how many changes and destroys it holds. */
export interface PlanCounts {
  add: number;
  change: number;
  destroy: number;
  changes: number;
  destroys: number;
}

/** A plan's counts as the binary's `Plan:` line gives them. A no-op or read is not a change. */
export function planCounts(plan: unknown): PlanCounts {
  const rc = isObj(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  let add = 0;
  let change = 0;
  let destroy = 0;
  let changes = 0;
  for (const r of rc) {
    const a: string[] = isObj(r) && isObj(r.change) && Array.isArray(r.change.actions) ? (r.change.actions as string[]) : [];
    if (a.every((x) => x === "no-op" || x === "read")) continue;
    changes++;
    if (a.includes("create")) add++;
    if (a.includes("delete")) destroy++;
    if (a.includes("update")) change++;
  }
  return { add, change, destroy, changes, destroys: destroy };
}

/**
 * One member's part of the composed plan's `show` text: the text before the
 * actions, each resource block of its module with `module.<m>.` taken off,
 * its line of counts, and its outputs by their own names.
 */
export function sliceText(text: string, m: string, counts: { add: number; change: number; destroy: number }): string {
  const lines = text.split("\n");
  const head: string[] = [];
  const blocks: string[][] = [];
  const outs: string[] = [];
  let i = 0;
  for (; i < lines.length && !/^\s{2}# /.test(lines[i]!); i++) {
    if (/^(Plan:|No changes\.|Changes to Outputs:)/.test(lines[i]!)) break;
    head.push(lines[i]!);
  }
  let cur: string[] | undefined;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s{2}# /.test(l)) {
      cur = [l];
      blocks.push(cur);
    } else if (/^(Plan:|Changes to Outputs:|─|Note:|Saved the plan)/.test(l)) {
      cur = undefined;
      if (l.startsWith("Changes to Outputs:")) {
        for (i++; i < lines.length && /^\s/.test(lines[i]!); i++) if (new RegExp(`^\\s+[-+~] ${m}__`).test(lines[i]!)) outs.push(lines[i]!.replace(`${m}__`, ""));
        i--;
      }
    } else if (cur) cur.push(l);
  }
  const mine = blocks
    .filter((b) => topModule(b[0]!.replace(/^\s{2}# /, "")) === m)
    .map((b) => [b[0]!.replace(`module.${m}.`, ""), ...b.slice(1)].join("\n").trimEnd());
  const parts = [head.join("\n").trimEnd()];
  if (mine.length === 0 && outs.length === 0) parts.push("No changes. Its part of the composed run matches the configuration.");
  else {
    if (mine.length) parts.push(mine.join("\n\n"));
    parts.push(`Plan: ${counts.add} to add, ${counts.change} to change, ${counts.destroy} to destroy.`);
    if (outs.length) parts.push(`Changes to Outputs:\n${outs.join("\n")}`);
  }
  return parts.filter((p) => p !== "").join("\n\n") + "\n";
}

// ── reads between members ─────────────────────────────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The names a root's files read off `data.<type>.<name>.<field>`, or
 * undefined when they read the whole object. While the root is composed
 * (./root.ts) a `terraform_remote_state` read is `var.chant_read_<name>`,
 * which counts the same.
 */
function fieldsRead(dir: string | undefined, type: string, name: string, field: string): Set<string> | undefined {
  const ref = type === "terraform_remote_state" ? `(?:data\\.${type}\\.|var\\.${READ_VAR_PREFIX})` : `data\\.${type}\\.`;
  const re = new RegExp(`\\b${ref}${escapeRe(name)}(?![\\w-])(\\.${field}(?:\\.([A-Za-z_][\\w-]*)|\\[\\s*"([^"]+)"\\s*\\])?)?`, "g");
  const read = new Set<string>();
  for (const t of dir ? rootTexts(dir) : []) {
    for (const hit of t.text.matchAll(re)) {
      const out = hit[2] ?? hit[3];
      if (!out) return undefined;
      read.add(out);
    }
  }
  return read;
}

/** One member's read of another member's outputs, planned on the upstream's part of the composed plan. */
export interface ComposedMemberRead {
  /** The member read. */
  upstream: string;
  via: ComposedRead["via"];
  /** The `vars` key, or the data block's label. */
  name: string;
  /** The outputs read, sorted. Undefined when the reader reads the whole object, so every output counts. */
  outputs?: string[];
  /** The outputs read that are known only once the upstream's part applies, sorted. */
  unknown: string[];
}

/**
 * Each member's reads of other members, planned on the upstream's part of
 * the composed plan: an output read that the upstream's planned outputs
 * ({@link terraformPlannedOutputs} of its slice) leave unknown is named
 * unknown. A `vars` read names its output; a `terraform_remote_state` or
 * `terraform_estate_outputs` block's outputs are read from the member's own
 * files, as terragucci's `outputsRead` and `estateValuesRead` did.
 */
export function composedReads(c: Pick<Composition, "members" | "reads" | "dirs">, outputs: ReadonlyMap<string, PlannedOutputs>): Map<string, ComposedMemberRead[]> {
  const out = new Map<string, ComposedMemberRead[]>();
  for (const member of c.members) {
    const reads: ComposedMemberRead[] = [];
    // Several `vars` reads of one upstream through one variable are one read.
    const byKey = new Map<string, { r: ComposedRead; outputs?: Set<string> }>();
    for (const r of c.reads.get(member) ?? []) {
      const planned = outputs.get(r.upstream);
      if (!planned) continue;
      if (r.via === "vars") {
        const key = `vars\u0000${r.upstream}\u0000${r.variable}`;
        const had = byKey.get(key);
        if (had) had.outputs!.add(r.output);
        else byKey.set(key, { r, outputs: new Set([r.output]) });
      } else {
        const read = r.via === "remote-state" ? fieldsRead(c.dirs.get(member), "terraform_remote_state", r.name, "outputs") : fieldsRead(c.dirs.get(member), "terraform_estate_outputs", r.name, "values");
        byKey.set(`${r.via}\u0000${r.upstream}\u0000${r.name}`, { r, ...(read ? { outputs: read } : {}) });
      }
    }
    for (const { r, outputs: read } of byKey.values()) {
      const planned = outputs.get(r.upstream)!;
      const unknown = [...new Set(planned.unknown)].filter((o) => read === undefined || read.has(o)).sort();
      reads.push({ upstream: r.upstream, via: r.via, name: r.via === "vars" ? r.variable : r.name, ...(read ? { outputs: [...read].sort() } : {}), unknown });
    }
    if (reads.length) out.set(member, reads);
  }
  return out;
}

// ── each member's plan ────────────────────────────────────────────────────

/** One member's part of a composed plan, in the form a capability's `plan` answers it. */
export interface ComposedMemberPlan extends CapabilityPlan {
  /** The member's root, as `terraform.roots` names it: the change set's member. */
  member: string;
  changeSet: ChangeSetPart;
  outputs: PlannedOutputs;
  /** `unknownInputs` are this member's reads of other members that the composed plan leaves unknown, as `<component>.<output>`. */
  shape: PlanShape;
  /** The member's part of `show -json`, as if it had planned alone. */
  slice: unknown;
  counts: PlanCounts;
  /** Its reads of other members. */
  reads: ComposedMemberRead[];
}

export interface ComposedMemberPlansOptions {
  /** The binary that planned. Default `terraform`. */
  planner?: ChangeSetPlanner;
  /** The estate or workspace each member plans into, by component. */
  scope?: (member: string) => string | undefined;
}

/**
 * Every member's plan out of the composed plan's `show -json`, by component:
 * {@link terraformChangeSetPart}, {@link terraformPlannedOutputs} and
 * {@link terraformPlanShape} of its slice, so each member's part is the part
 * a plan of its root alone gives on the same state. The member is the root's
 * name (`Composition.roots`), as a single `terraform-apply` plan names it.
 */
export function composedMemberPlans(c: Pick<Composition, "members" | "order" | "modules" | "reads" | "dirs" | "roots">, plan: unknown, options: ComposedMemberPlansOptions = {}): Record<string, ComposedMemberPlan> {
  const slices = new Map(c.order.map((member) => [member, slicePlan(plan, c.modules.get(member)!)] as const));
  const outputs = new Map(c.order.map((member) => [member, terraformPlannedOutputs(slices.get(member))] as const));
  const reads = composedReads(c, outputs);
  const result: Record<string, ComposedMemberPlan> = {};
  for (const member of c.order) {
    const slice = slices.get(member);
    const root = c.roots.get(member) ?? member;
    const scope = options.scope?.(member);
    const changeSet = terraformChangeSetPart({ member: root, plan: slice, ...(options.planner ? { planner: options.planner } : {}), ...(scope ? { scope } : {}) });
    const mine = reads.get(member) ?? [];
    const unknownInputs = [...new Set(mine.flatMap((r) => r.unknown.map((o) => `${r.upstream}.${o}`)))].sort();
    result[member] = {
      member: root,
      planDigest: changeSet.member.planDigest ?? "",
      changeSet,
      outputs: outputs.get(member)!,
      shape: terraformPlanShape(slice, root, { unknownInputs }),
      slice,
      counts: planCounts(slice),
      reads: mine,
    };
  }
  return result;
}
