/**
 * Change-set adapters for the terraform family (#3181): a `terraform show
 * -json` plan from terraform, tofu or choudoufu, and a choudoufu set plan
 * document (`live-plan-set -json`, choudoufu#1752), each into
 * `@intentius/chant/change-set` parts.
 *
 * A member's plan digest is {@link terraformPlanDigest}, the value a
 * `TerraformApplyOp` gate on that root binds (#2300), so a change set over
 * one root and a gate over the same root agree on what changed.
 *
 * This module imports `./plan-digest` and chant's `change-set` and
 * `lifecycle/plan-digest` subpaths, never the lexicon's entry point, so it
 * bundles without TypeScript or the lint rules (#3421).
 */

import type {
  ChangeSetAction,
  ChangeSetAttribute,
  ChangeSetDisruption,
  ChangeSetEntry,
  ChangeSetPart,
  ChangeSetPlanner,
  ChangeSetSideEffect,
} from "@intentius/chant/change-set";
import { terraformPlanDigest } from "./plan-digest";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether a sensitivity or unknown map marks anything under it `true`. */
function marks(v: unknown): boolean {
  if (v === true) return true;
  if (Array.isArray(v)) return v.some(marks);
  if (isObject(v)) return Object.values(v).some(marks);
  return false;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return false;
}

/**
 * The planner a root's binary names: `choudoufu` and `tofu` by name, and
 * `terraform` for anything else, a path to terraform included.
 */
export function plannerForBinary(binary: string | undefined): ChangeSetPlanner {
  const base = (binary ?? "terraform").split(/[\\/]/).pop() ?? "";
  if (base.startsWith("choudoufu")) return "choudoufu";
  if (base.startsWith("tofu")) return "tofu";
  return "terraform";
}

/**
 * The action a `resource_changes` entry's `actions` array means. Delete then
 * create and create then delete are both a replace; the order is the
 * disruption ({@link disruptionFor}).
 */
export function actionFor(actions: unknown): ChangeSetAction {
  const a = Array.isArray(actions) ? actions.map(String) : [];
  if (a.length === 2 && a.includes("delete") && a.includes("create")) return "replace";
  if (a.length === 1) {
    switch (a[0]) {
      case "create": case "update": case "delete": case "read": case "no-op": case "forget":
        return a[0];
    }
  }
  throw new Error(`a plan entry has actions ${JSON.stringify(actions)}, which the change set has no action for`);
}

function disruptionFor(actions: unknown, action: ChangeSetAction): ChangeSetDisruption | undefined {
  switch (action) {
    case "update": return "in-place";
    case "delete": return "destroy";
    case "replace": return (actions as string[])[0] === "create" ? "replace" : "destroy";
    default: return undefined;
  }
}

/** A resource address's module path, name and index, read off the address when the entry does not carry them. */
export function parseTerraformAddress(address: string): { module?: string; type: string; name: string; index?: string | number } {
  // Module segments, then [data.]type.name[index]. Index brackets may hold a quoted key with dots in it.
  const re = /^((?:module\.[^.[\]]+(?:\[(?:"(?:[^"\\]|\\.)*"|\d+)\])?\.)*)(?:data\.)?([^.[\]]+)\.([^.[\]]+)(?:\[("(?:[^"\\]|\\.)*"|\d+)\])?$/;
  const m = re.exec(address);
  if (!m) return { type: "unknown", name: address };
  const module = m[1] ? m[1].slice(0, -1) : undefined;
  const index = m[4] === undefined ? undefined : m[4].startsWith('"') ? (JSON.parse(m[4]) as string) : Number(m[4]);
  return { ...(module ? { module } : {}), type: m[2], name: m[3], ...(index !== undefined ? { index } : {}) };
}

/** The attributes one change writes, top-level, with sensitive values left out. */
function attributesFor(change: Json, action: ChangeSetAction): ChangeSetAttribute[] {
  if (action === "delete" || action === "no-op" || action === "forget" || action === "read") return [];
  const before = isObject(change.before) ? change.before : {};
  const after = isObject(change.after) ? change.after : {};
  const afterUnknown = isObject(change.after_unknown) ? change.after_unknown : {};
  const beforeSensitive = isObject(change.before_sensitive) ? change.before_sensitive : {};
  const afterSensitive = isObject(change.after_sensitive) ? change.after_sensitive : {};
  const forcing = new Set(
    (Array.isArray(change.replace_paths) ? change.replace_paths : [])
      .map((p) => (Array.isArray(p) ? p[0] : undefined))
      .filter((k): k is string => typeof k === "string"),
  );
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(afterUnknown)])].sort();
  const out: ChangeSetAttribute[] = [];
  for (const k of keys) {
    const unknown = marks(afterUnknown[k]);
    const hasBefore = action !== "create" && before[k] !== undefined && before[k] !== null;
    const hasAfter = after[k] !== undefined && after[k] !== null;
    if (action === "create" ? !hasAfter && !unknown : !unknown && sameJson(before[k] ?? null, after[k] ?? null)) continue;
    const sensitive = marks(beforeSensitive[k]) || marks(afterSensitive[k]);
    out.push({
      path: k,
      ...(sensitive ? { sensitive: true as const } : {
        ...(hasBefore ? { before: before[k] } : {}),
        ...(hasAfter && !unknown ? { after: after[k] } : {}),
      }),
      ...(unknown ? { unknown: true as const } : {}),
      ...(forcing.has(k) ? { forcesReplacement: true as const } : {}),
    });
  }
  return out;
}

function regionOf(change: Json): string | undefined {
  for (const side of [change.after, change.before]) {
    if (isObject(side) && typeof side.region === "string" && side.region !== "") return side.region;
  }
  return undefined;
}

export interface TerraformChangeSetPartInput {
  /** The member's name: the root's name in `terraform.roots`, which a workspace member of kind terraform or choudoufu shares. */
  member: string;
  /** `terraform show -json <planfile>`, parsed. */
  plan: unknown;
  /** The binary that planned it, or the planner by name. Default `terraform`. */
  planner?: ChangeSetPlanner;
  /** The estate or workspace the root plans into. */
  scope?: string;
  /** The planner's own digest of this plan, when it printed one. */
  nativeDigest?: string;
}

/**
 * One terraform-family root's part, from its `show -json` plan.
 *
 * Every `resource_changes` entry becomes an entry, no-op and read included.
 * A plan stock marked `errored` is a failed member: its entries are kept,
 * but nothing should apply it.
 */
export function terraformChangeSetPart(input: TerraformChangeSetPartInput): ChangeSetPart {
  const plan = isObject(input.plan) ? input.plan : {};
  const planner = input.planner ?? "terraform";
  const raw = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const entries: ChangeSetEntry[] = raw.map((r): ChangeSetEntry => {
    const rc = isObject(r) ? r : {};
    const change = isObject(rc.change) ? rc.change : {};
    const address = String(rc.address ?? "");
    const parsed = parseTerraformAddress(address);
    const action = actionFor(change.actions);
    const disruption = disruptionFor(change.actions, action);
    const region = regionOf(change);
    const index = rc.index !== undefined && rc.index !== null ? (rc.index as string | number) : parsed.index;
    const module = typeof rc.module_address === "string" ? rc.module_address : parsed.module;
    return {
      member: input.member,
      lexicon: "terraform",
      planner,
      address,
      type: typeof rc.type === "string" ? rc.type : parsed.type,
      name: typeof rc.name === "string" ? rc.name : parsed.name,
      ...(index !== undefined ? { index } : {}),
      ...(module ? { module } : {}),
      ...(typeof rc.deposed === "string" ? { deposed: rc.deposed } : {}),
      action,
      ...(isObject(change.importing) ? { importing: true as const } : {}),
      ...(disruption ? { disruption } : {}),
      ...(region ? { region } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      attributes: attributesFor(change, action),
    };
  });
  const sideEffects = (Array.isArray(plan.action_invocations) ? plan.action_invocations : []).map(sideEffectFor);
  const errored = plan.errored === true;
  return {
    member: {
      member: input.member,
      lexicon: "terraform",
      planner,
      ...(input.scope ? { scope: input.scope } : {}),
      status: errored ? "failed" : "planned",
      ...(errored ? { error: `${planner} marked the plan errored` } : {}),
      planDigest: terraformPlanDigest(plan),
      ...(input.nativeDigest ? { nativeDigest: input.nativeDigest } : {}),
      holes: [],
    },
    entries,
    ...(sideEffects.length > 0 ? { sideEffects } : {}),
  };
}

/**
 * One `action_invocations` entry of a plan (Terraform 1.14): the action's
 * address and type, and, for a lifecycle trigger, the resource and event.
 */
function sideEffectFor(raw: unknown): Omit<ChangeSetSideEffect, "member"> {
  const inv = isObject(raw) ? raw : {};
  const type = typeof inv.type === "string" ? inv.type : "unknown";
  const lifecycle = isObject(inv.lifecycle_action_trigger) ? inv.lifecycle_action_trigger : {};
  return {
    address: typeof inv.address === "string" ? inv.address : type,
    type,
    ...(typeof lifecycle.triggering_resource_address === "string" ? { trigger: lifecycle.triggering_resource_address } : {}),
    ...(typeof lifecycle.action_trigger_event === "string" ? { event: lifecycle.action_trigger_event } : {}),
  };
}

/** One root of a choudoufu set plan document: the fields the adapter reads. */
interface SetPlanRoot {
  root: string;
  estate?: string;
  status?: string;
  error?: string;
  stage?: string;
  plan?: unknown;
  digest?: string;
}

export interface ChoudoufuSetPlanInput {
  /** `choudoufu live-plan-set -json`, parsed. */
  document: unknown;
  /** The member a root belongs to. Default: the root's directory as the set names it. */
  memberFor?: (root: string, estate: string | undefined) => string;
}

/**
 * One part per root of a choudoufu set plan (choudoufu#1752). A planned
 * root is {@link terraformChangeSetPart} over its embedded plan, with the
 * estate as scope and choudoufu's own root digest as `nativeDigest`. A
 * failed root is a failed member with its error and no plan digest.
 */
export function choudoufuSetPlanParts(input: ChoudoufuSetPlanInput): ChangeSetPart[] {
  const doc = isObject(input.document) ? input.document : {};
  if (!Array.isArray(doc.roots)) throw new Error('not a choudoufu set plan document: no top-level "roots"');
  return (doc.roots as SetPlanRoot[]).map((r) => {
    const member = input.memberFor ? input.memberFor(r.root, r.estate || undefined) : r.root;
    const scope = r.estate || undefined;
    if (r.status === "planned" && isObject(r.plan)) {
      return terraformChangeSetPart({ member, plan: r.plan, planner: "choudoufu", ...(scope ? { scope } : {}), ...(r.digest ? { nativeDigest: r.digest } : {}) });
    }
    return {
      member: {
        member,
        lexicon: "terraform",
        planner: "choudoufu" as const,
        ...(scope ? { scope } : {}),
        status: "failed" as const,
        error: r.error || `the root did not plan (${r.status ?? "no status"}${r.stage ? `, at ${r.stage}` : ""})`,
        planDigest: null,
        ...(r.digest ? { nativeDigest: r.digest } : {}),
        holes: [],
      },
      entries: [],
    };
  });
}
