/**
 * The change-set adapter for a Pulumi member (#4453): `pulumi preview --json`
 * into an `@intentius/chant/change-set` part, planner `pulumi`.
 *
 * ## Steps to entries
 *
 * The preview prints one step per resource the program registered, `same`
 * included, and a replace as two or three steps on one URN
 * (`create-replacement`, `replace`, `delete-replaced`). The adapter keeps one
 * entry per URN, at the URN, so `node` comes from the one URN rule
 * (`@intentius/chant/pulumi-urn`, #4456):
 *
 * | step op | action | disruption |
 * |---|---|---|
 * | `create` | create | |
 * | `update` | update | in-place |
 * | `delete` | delete | destroy |
 * | `replace`, `create-replacement`, `delete-replaced` | replace | replace, or destroy when the delete comes first (`deleteBeforeReplace`) |
 * | `same` | no-op | |
 * | `read`, `read-replacement`, `refresh` | read | |
 * | `import` | no-op, importing | |
 * | `import-replacement` | replace, importing | replace |
 * | `discard`, `remove-pending-replace` | forget | |
 *
 * An op the table does not hold is a hole on the member, never a guess.
 *
 * Attributes are top-level inputs, as the change set wants them. A create
 * writes every input. An update or replace writes the keys `detailedDiff`
 * and `diffReasons` name, and every input whose new value holds an unknown.
 * `replaceReasons` and a `detailedDiff` kind ending in `-replace` mark
 * `forcesReplacement`. An input that holds Pulumi's unknown sentinel is
 * `unknown: true` with no `after`: a resource that reads an output of one
 * being created shows its dependent input as unknown. A value that holds a
 * secret is `sensitive: true` with neither side.
 *
 * ## What preview cannot list: `mayAppear`
 *
 * A program may register resources inside an `apply()`. At preview an
 * `apply()` whose input is unknown does not run, so what it would register
 * is never in the steps. Dropping it would make the set look smaller than
 * the apply, so the adapter marks it `mayAppear` instead, on two signals:
 *
 * 1. A component (a step whose state is `custom: false`, not the root stack)
 *    whose subtree in the preview holds an unknown, in any input or output,
 *    or a create or replace, whose outputs are unknown until apply. Its code
 *    may be waiting on that value to register children. It gets one entry
 *    at `pulumiMayAppearAddress(<component urn>)`, action `create`, type
 *    `unknown`, no attributes, on the component's node.
 * 2. With the last deployment's `pulumi stack export` (`prior`): a resource
 *    the export holds and the preview has no step for gets an `update`
 *    entry with disruption `unknown`, since a full preview lists every
 *    registered resource and only an `apply()` that did not run leaves one
 *    out. A `delete` step for a resource under a component signal 1 marks
 *    keeps its `delete` and gets `mayAppear`, since the `apply()` may
 *    register it again. A preview narrowed with `--target` (`targeted`)
 *    lists only its targets, and a failed one stops part way, so signal 2's
 *    first half is off for both.
 *
 * A resource registered inside an `apply()` directly under the stack, with
 * no export that holds it, has no component to stand under and is not
 * detected. That is the one case left out.
 *
 * ## The digest
 *
 * {@link pulumiPreviewDigest}: `computePlanDigest("pulumi-preview", …)` over
 * each step's op, URN, provider, id, inputs before and after, `diffReasons`,
 * `replaceReasons` and `detailedDiff`, sorted by URN and op. It leaves out
 * `config`, `duration`, `diagnostics` and `changeSummary`, and the states'
 * outputs, which at preview are the last deployment's or unknown.
 *
 * The fixtures under `testdata/pulumi-preview` are hand-written to the
 * documented `pulumi preview --json` shape (`steps[].op/urn/oldState/
 * newState/diffReasons/replaceReasons/detailedDiff`), not recorded from a
 * real run.
 *
 * ## The import graph
 *
 * Like the terraform lexicon's `change-set`, this imports chant's
 * `change-set` types, `lifecycle/plan-digest`, `pulumi-urn` and `./values`,
 * so it bundles without TypeScript, node's process modules or zod (#3421).
 */

import type {
  ChangeSetAction,
  ChangeSetAttribute,
  ChangeSetDisruption,
  ChangeSetEntry,
  ChangeSetHole,
  ChangeSetPart,
} from "@intentius/chant/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { isPulumiNodeless, parsePulumiUrn, pulumiMayAppearAddress, PULUMI_STACK_TYPE } from "@intentius/chant/pulumi-urn";
import { holdsSecret, holdsUnknown, isObject, isUnknown, propertyKeys, topLevelKey, type Json } from "./values";

/** One resource state on a preview step, `apitype.ResourceV3`, as far as the adapter reads it. */
export interface PulumiStepState {
  urn?: string;
  custom?: boolean;
  delete?: boolean;
  id?: string;
  type?: string;
  parent?: string;
  inputs?: Json;
  outputs?: Json;
}

/** One step of `pulumi preview --json` or `pulumi refresh --preview-only --json`. */
export interface PulumiStep {
  op?: string;
  urn?: string;
  provider?: string;
  oldState?: PulumiStepState;
  newState?: PulumiStepState;
  diffReasons?: string[];
  replaceReasons?: string[];
  detailedDiff?: Record<string, { kind?: string; inputDiff?: boolean }> | null;
}

/** The steps of a preview or refresh document, or undefined when it has none. */
export function pulumiSteps(doc: unknown): PulumiStep[] | undefined {
  if (!isObject(doc) || !Array.isArray(doc.steps)) return undefined;
  return (doc.steps as unknown[]).filter((s): s is PulumiStep => isObject(s) && typeof s.urn === "string");
}

/** One resource of a `pulumi stack export`, as far as the adapter reads it. */
export interface PulumiExportedResource {
  urn: string;
  type: string;
  custom?: boolean;
  id?: string;
  parent?: string;
}

/** The resources of a `pulumi stack export` document (`deployment.resources`). Not one: an empty list. */
export function pulumiExportResources(doc: unknown): PulumiExportedResource[] {
  const deployment = isObject(doc) && isObject(doc.deployment) ? doc.deployment : undefined;
  const list = deployment && Array.isArray(deployment.resources) ? deployment.resources : [];
  return list.filter((r): r is PulumiExportedResource => isObject(r) && typeof r.urn === "string" && typeof r.type === "string");
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The member's plan digest: `computePlanDigest("pulumi-preview", …)` over
 * what each step proposes, sorted by URN and op, so two renderings of one
 * preview agree. See the module comment for what it leaves out.
 */
export function pulumiPreviewDigest(preview: unknown): string {
  const steps = (pulumiSteps(preview) ?? [])
    .map((s) => ({
      op: s.op ?? null,
      urn: s.urn ?? null,
      provider: s.provider ?? null,
      id: s.newState?.id ?? s.oldState?.id ?? null,
      before: s.oldState?.inputs ?? null,
      after: s.newState?.inputs ?? null,
      diffReasons: [...(s.diffReasons ?? [])].sort(),
      replaceReasons: [...(s.replaceReasons ?? [])].sort(),
      detailedDiff: s.detailedDiff ?? null,
    }))
    .sort((a, b) => byString(`${a.urn}\u0000${a.op}`, `${b.urn}\u0000${b.op}`));
  return computePlanDigest("pulumi-preview", steps);
}

const REPLACE_OPS = new Set(["replace", "create-replacement", "delete-replaced"]);

/** The action and disruption one URN's steps mean, or undefined for an op the change set has no action for. */
function actionOf(steps: PulumiStep[]): { action: ChangeSetAction; disruption?: ChangeSetDisruption; importing?: true } | undefined {
  const ops = steps.map((s) => s.op ?? "");
  if (ops.includes("import-replacement")) return { action: "replace", disruption: "replace", importing: true };
  if (ops.some((o) => REPLACE_OPS.has(o))) {
    const del = ops.indexOf("delete-replaced");
    const create = ops.indexOf("create-replacement");
    return { action: "replace", disruption: del >= 0 && create >= 0 && del < create ? "destroy" : "replace" };
  }
  if (ops.length !== 1) return undefined;
  switch (ops[0]) {
    case "create": return { action: "create" };
    case "update": return { action: "update", disruption: "in-place" };
    case "delete": return { action: "delete", disruption: "destroy" };
    case "same": return { action: "no-op" };
    case "read": case "read-replacement": case "refresh": return { action: "read" };
    case "import": return { action: "no-op", importing: true };
    case "discard": case "remove-pending-replace": return { action: "forget" };
    default: return undefined;
  }
}

/** The state before and after across one URN's steps: the first old state and the last new one. */
function statesOf(steps: PulumiStep[]): { before?: PulumiStepState; after?: PulumiStepState } {
  const before = steps.find((s) => isObject(s.oldState))?.oldState;
  const after = [...steps].reverse().find((s) => isObject(s.newState) && s.op !== "delete-replaced" && s.op !== "delete")?.newState;
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

function attributesOf(steps: PulumiStep[], action: ChangeSetAction, states: { before?: PulumiStepState; after?: PulumiStepState }): ChangeSetAttribute[] {
  if (action !== "create" && action !== "update" && action !== "replace") return [];
  const before = isObject(states.before?.inputs) ? states.before!.inputs! : {};
  const after = isObject(states.after?.inputs) ? states.after!.inputs! : {};
  const forcing = new Set<string>();
  const named = new Set<string>();
  for (const s of steps) {
    for (const k of s.replaceReasons ?? []) forcing.add(topLevelKey(k));
    for (const k of s.diffReasons ?? []) named.add(topLevelKey(k));
    for (const [path, d] of Object.entries(s.detailedDiff ?? {})) {
      named.add(topLevelKey(path));
      if (typeof d?.kind === "string" && d.kind.endsWith("-replace")) forcing.add(topLevelKey(path));
    }
  }
  const keys =
    action === "create"
      ? propertyKeys(after)
      : [...new Set([...named, ...propertyKeys(after).filter((k) => holdsUnknown(after[k]))])].filter((k) => !k.startsWith("__"));
  const out: ChangeSetAttribute[] = [];
  for (const k of keys.sort()) {
    const unknown = holdsUnknown(after[k]);
    const hasBefore = action !== "create" && before[k] !== undefined && before[k] !== null;
    const hasAfter = after[k] !== undefined && after[k] !== null;
    // On an update a key the diff names is listed even when both sides read the same: the provider said it changes.
    if (action === "create" && !hasAfter && !unknown) continue;
    const sensitive = holdsSecret(before[k]) || holdsSecret(after[k]);
    out.push({
      path: k,
      ...(sensitive
        ? { sensitive: true as const }
        : {
            ...(hasBefore ? { before: before[k] } : {}),
            ...(hasAfter && !unknown ? { after: after[k] } : {}),
          }),
      ...(unknown ? { unknown: true as const } : {}),
      ...(forcing.has(k) ? { forcesReplacement: true as const } : {}),
    });
  }
  return out;
}

const knownId = (id: unknown): string | undefined => (typeof id === "string" && id !== "" && !isUnknown(id) ? id : undefined);

export interface PulumiPreviewPartInput {
  /** The workspace member's name, which names its graph nodes (`<member>/<key>`). */
  member: string;
  /** `pulumi preview --json`, parsed. */
  preview: unknown;
  /** The stack the preview ran against, recorded as `scope`. */
  stack?: string;
  /**
   * The last deployment, as `pulumi stack export` prints it: the member's
   * checked-in `stack-export.json`. With it, a resource the preview leaves
   * out is a `mayAppear` entry rather than silence.
   */
  prior?: unknown;
  /** The preview was narrowed with `--target`, so it lists only its targets. */
  targeted?: boolean;
  /** The preview failed: the member is failed with this error, and keeps whatever steps it printed. */
  error?: string;
}

/**
 * A Pulumi member's part, from its `pulumi preview --json`. Throws when the
 * document has no `steps` and no `error` says why.
 */
export function pulumiPreviewPart(input: PulumiPreviewPartInput): ChangeSetPart {
  const steps = pulumiSteps(input.preview);
  if (steps === undefined && input.error === undefined) throw new Error('not a pulumi preview --json document: no top-level "steps"');
  const scope = input.stack ? { scope: input.stack } : {};
  const base = { member: input.member, lexicon: "pulumi", planner: "pulumi" as const };

  // One URN's steps, in the order the preview printed them.
  const byUrn = new Map<string, PulumiStep[]>();
  for (const s of steps ?? []) {
    const list = byUrn.get(s.urn!) ?? [];
    list.push(s);
    byUrn.set(s.urn!, list);
  }

  const entries: ChangeSetEntry[] = [];
  const holes: ChangeSetHole[] = [];
  const actions = new Map<string, ChangeSetAction>();
  const states = new Map<string, { before?: PulumiStepState; after?: PulumiStepState }>();
  for (const [urn, list] of byUrn) {
    const parsed = parsePulumiUrn(urn);
    const st = statesOf(list);
    states.set(urn, st);
    const type = st.after?.type ?? st.before?.type ?? parsed?.type ?? "unknown";
    const mapped = actionOf(list);
    if (!mapped) {
      holes.push({ address: urn, type, reason: `pulumi printed ${list.map((s) => s.op ?? "no op").join(", ")} for the URN, which the change set has no action for` });
      continue;
    }
    actions.set(urn, mapped.action);
    const id = knownId(st.after?.id) ?? knownId(st.before?.id);
    entries.push({
      ...base,
      address: urn,
      type,
      ...(parsed ? { name: parsed.name } : {}),
      ...(id ? { id } : {}),
      action: mapped.action,
      ...(mapped.importing ? { importing: true as const } : {}),
      ...(mapped.disruption ? { disruption: mapped.disruption } : {}),
      ...scope,
      attributes: attributesOf(list, mapped.action, st),
    });
  }

  // Signal 1: components whose subtree waits on a value preview does not know.
  const parentOf = new Map<string, string>();
  for (const [urn, st] of states) {
    const parent = st.after?.parent ?? st.before?.parent;
    if (typeof parent === "string") parentOf.set(urn, parent);
  }
  const isComponent = (urn: string): boolean => {
    const st = states.get(urn);
    const state = st?.after ?? st?.before;
    const type = state?.type ?? parsePulumiUrn(urn)?.type ?? "";
    return state?.custom === false && type !== PULUMI_STACK_TYPE && !isPulumiNodeless(type);
  };
  const waits = (urn: string): boolean => {
    const action = actions.get(urn);
    if (action === "create" || action === "replace") return true;
    const st = states.get(urn);
    return holdsUnknown(st?.after?.inputs) || holdsUnknown(st?.after?.outputs);
  };
  const flagged = new Set<string>();
  for (const urn of byUrn.keys()) {
    if (actions.get(urn) === "delete" || !waits(urn)) continue;
    // The resource and every component above it, up to the stack.
    const seen = new Set<string>();
    for (let at: string | undefined = urn; at !== undefined && !seen.has(at); at = parentOf.get(at)) {
      seen.add(at);
      if (isComponent(at) && actions.get(at) !== "delete") flagged.add(at);
    }
  }
  for (const component of [...flagged].sort()) {
    entries.push({ ...base, address: pulumiMayAppearAddress(component), type: "unknown", action: "create", mayAppear: true, ...scope, attributes: [] });
  }
  const underFlagged = (urn: string): boolean => {
    const seen = new Set<string>();
    for (let at = parentOf.get(urn); at !== undefined && !seen.has(at); at = parentOf.get(at)) {
      seen.add(at);
      if (flagged.has(at)) return true;
    }
    return false;
  };
  for (const e of entries) {
    if (e.action === "delete" && e.mayAppear !== true && underFlagged(e.address)) e.mayAppear = true;
  }

  // Signal 2: what the last deployment holds and the preview never listed.
  // A failed preview stopped part way, so what it did not list says nothing.
  if (input.prior !== undefined && !input.targeted && input.error === undefined) {
    for (const r of pulumiExportResources(input.prior)) {
      if (byUrn.has(r.urn) || isPulumiNodeless(r.type)) continue;
      const parsed = parsePulumiUrn(r.urn);
      const id = knownId(r.id);
      entries.push({
        ...base,
        address: r.urn,
        type: r.type,
        ...(parsed ? { name: parsed.name } : {}),
        ...(id ? { id } : {}),
        action: "update",
        disruption: "unknown",
        mayAppear: true,
        ...scope,
        attributes: [],
      });
    }
  }

  const failed = input.error !== undefined;
  return {
    member: {
      ...base,
      ...scope,
      status: failed ? "failed" : "planned",
      ...(failed ? { error: input.error } : {}),
      planDigest: failed ? null : pulumiPreviewDigest(input.preview),
      holes,
    },
    entries,
  };
}
