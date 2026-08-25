/**
 * The pipeline-change gate class (#1569): changes to the pipeline itself
 * route to a stricter gate.
 *
 * The honest concession in the PR-flow teardown (rubric-product-research,
 * 06-objections §1): chant Ops have a `shell` step, so a governed plane is
 * not automatically immune to "the change edits the machinery that applies
 * changes." What chant *can* claim — and a plain PR flow structurally cannot
 * — is that pipeline changes are distinguishable: a composition is data over
 * a bounded verb registry, and the COMP rules already police the escape
 * hatches (COMP006 — every `shell` step carries a declared reason;
 * COMP005 — no noun-shaped escape hatches, `./rules/comp/`). What was missing
 * was the routing: nothing classified a change as "touches the pipeline" and
 * required a stricter gate for it, so a change to a composition rode through
 * the same gate as a replica-count bump.
 *
 * This is the cheap first cut #1569 asks for: the registry-only predicate.
 * A composition that contains only registry verbs is ordinary; a `shell`
 * step (the deliberate escape hatch) or a change to the set of verbs a
 * composition invokes trips the stricter class. comp005/comp006 already make
 * both decidable from the text — this module reuses the same walk
 * (`./rules/comp/support.ts`) rather than re-deriving it.
 *
 * Like #1568's `evaluateUnobservedGate`
 * (../lifecycle/unobserved-gate.ts), this is a reusable predicate, not a
 * runtime: classify a change and get back a verdict; the caller (a
 * `lint.policies` check routed through `policyGate`, an Op step, #1487's
 * gate-as-fact once it lands) decides what "stricter" means in its own
 * context. The stricter class composes with #1487's principle that
 * destructive verbs always wait for a person — pipeline changes are the
 * second category that should never free-run, because they change what
 * "gated" means for everything after them. That is why the default policy
 * below is `"human-always"`, not `"stricter-gate"`.
 */
import type { Component } from "../components/component";
import { STARTER_VERB_FAMILIES } from "../components/starter-plugin";
import { walkComponent } from "./rules/comp/support";

/**
 * Fallback registry when no project registry is supplied: core's own starter
 * verbs, the same fallback COMP005 uses for a direct unit test
 * (`./rules/comp/comp005-capability-kind-is-noun.ts`). A real `chant lint` /
 * gate run passes the project's resolved `knownKinds` (core's starter set
 * plus the active lexicons' leaves) so a real project's cloud verbs are never
 * mistaken for an out-of-registry escape hatch.
 */
const CORE_STARTER_KINDS: ReadonlySet<string> = new Set(Object.values(STARTER_VERB_FAMILIES).flat());

/** Why a composition (or a change to one) tripped the pipeline-change class. */
export type PipelineChangeReason =
  | { kind: "shell-step"; phaseName: string }
  | { kind: "unregistered-verb"; stepKind: string; phaseName: string }
  | { kind: "verb-set-changed"; added: string[]; removed: string[] };

export interface PipelineChangeClassification {
  /** True when any reason below applies. */
  pipelineChange: boolean;
  reasons: PipelineChangeReason[];
}

/** Every non-gate step kind a component's composition invokes, across `deploy` and `rollback` (nested fan-out phases included, via `walkComponent`). `gate` steps are excluded — they are not a capability verb. */
export function componentVerbSet(component: Component): Set<string> {
  const { steps } = walkComponent(component);
  return new Set(steps.map((s) => s.step.kind));
}

/**
 * Classify a single component's composition (the "cheap first cut", no
 * before/after needed): a `shell` step trips the class unconditionally — it
 * is the escape hatch by construction (COMP006) — and any step whose `kind`
 * is outside `knownKinds` trips it too, since an unregistered verb is,
 * structurally, the same kind of hole a `shell` step is: something the
 * bounded registry does not account for.
 */
export function classifyComponentPipelineChange(
  component: Component,
  opts?: { knownKinds?: ReadonlySet<string> },
): PipelineChangeClassification {
  const knownKinds = opts?.knownKinds ?? CORE_STARTER_KINDS;
  const { steps } = walkComponent(component);

  const reasons: PipelineChangeReason[] = [];
  for (const { step, phaseName } of steps) {
    if (step.kind === "shell") {
      reasons.push({ kind: "shell-step", phaseName });
    } else if (!knownKinds.has(step.kind)) {
      reasons.push({ kind: "unregistered-verb", stepKind: step.kind, phaseName });
    }
  }

  return { pipelineChange: reasons.length > 0, reasons };
}

/**
 * Classify a *change* to a component's composition between two revisions
 * (#1569's "add or modify a shell step ... or the composition graph
 * itself"): on top of `classifyComponentPipelineChange`'s single-composition
 * check on `after`, a change also trips the class when the verb set itself
 * changed — a verb added or removed changes what the composition can invoke,
 * which is the routing signal even when every individual verb, before and
 * after, is registry-clean. `before: undefined` (a brand-new component) never
 * reports a verb-set change — there is nothing to diff against, and the
 * single-composition check already covers a new component's own shell/
 * unregistered-verb findings.
 */
export function classifyPipelineChange(
  before: Component | undefined,
  after: Component,
  opts?: { knownKinds?: ReadonlySet<string> },
): PipelineChangeClassification {
  const base = classifyComponentPipelineChange(after, opts);
  if (!before) return base;

  const beforeVerbs = componentVerbSet(before);
  const afterVerbs = componentVerbSet(after);
  const added = [...afterVerbs].filter((v) => !beforeVerbs.has(v)).sort();
  const removed = [...beforeVerbs].filter((v) => !afterVerbs.has(v)).sort();

  if (added.length === 0 && removed.length === 0) return base;

  return {
    pipelineChange: true,
    reasons: [...base.reasons, { kind: "verb-set-changed", added, removed }],
  };
}

/**
 * How the gate routes a classified pipeline change.
 *
 * - `"human-always"` (the recommended default — see this module's doc
 *   comment) — a pipeline change never free-runs, mirroring #1487's "a
 *   destructive verb always waits for a person."
 * - `"stricter-gate"` — route to a named stricter gate class rather than
 *   requiring a person on every run; the caller supplies what "stricter"
 *   means (an additional approval, a narrower blast-radius budget, ...).
 */
export type PipelineChangeGatePolicy = "stricter-gate" | "human-always";

export interface PipelineChangeGateVerdict extends PipelineChangeClassification {
  /** What the policy says to do about it. `"none"` when the change is not a pipeline change at all. */
  route: PipelineChangeGatePolicy | "none";
}

/** Evaluate a component composition change against a routing policy. Pure — no I/O. */
export function evaluatePipelineChangeGate(
  before: Component | undefined,
  after: Component,
  policy: PipelineChangeGatePolicy = "human-always",
  opts?: { knownKinds?: ReadonlySet<string> },
): PipelineChangeGateVerdict {
  const classification = classifyPipelineChange(before, after, opts);
  return { ...classification, route: classification.pipelineChange ? policy : "none" };
}
