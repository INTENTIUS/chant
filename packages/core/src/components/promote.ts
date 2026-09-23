/**
 * Promote a release to another environment without rebuilding (#2530).
 *
 * `chant run --components <name> --env prod` runs the component's whole
 * `deploy` composition, and a composition that builds (a `Build` phase with
 * `docker-build`) builds again in prod. The release ledger already knows which
 * digest staging is running, so a promote reads that record and deploys the
 * same artifact to the target environment instead.
 *
 * The mechanism is a transform on the composition, not a change to the driver:
 *
 *  - build-time steps (`BUILD_STEP_KINDS`) are removed, so nothing is built;
 *  - the publish step stays. It moves the archived bytes to the target
 *    environment, which is what "promote by digest" means in the build-archive
 *    model, and its output is checked against the recorded digest. A publish
 *    that produces any other digest fails the step, and so the component,
 *    before anything after it runs;
 *  - gates, apply, verify and every other step run exactly as a normal deploy
 *    to the target environment would run them, so the target's gates apply.
 *
 * A composition the transform cannot pin to one recorded digest is refused
 * before anything runs: one with no publish step (nothing would carry the
 * digest), one with more than one (the ledger records one digest per
 * component), and one whose remaining steps read an output of a removed build
 * step (it would resolve to nothing).
 *
 * The driver stays capability-agnostic. The two kind lists below are data, in
 * the same spirit as `DEPLOY_UNIT_RULES` (./deploy-units.ts).
 */

import { parseWiringRef, type WiringRef } from "../lint/rules/comp/support";
import { latestPerComponent, type ReleaseRecord, type ReleaseRecordInput, type RunOrigin } from "../lifecycle/release-ledger";
import { CapabilityRegistry, type Capability } from "./capability";
import {
  runInterpretDriver,
  DriverRunFailure,
  type DriverComponent,
  type DriverComponentResult,
  type DriverGate,
  type DriverPhase,
  type DriverRunResult,
  type DriverStep,
} from "./driver";
import type { GateLedgerPort } from "../op/gate";
import type { RunProgressEvent } from "./run-progress";

/**
 * Step kinds that produce an artifact at build time: the build family, and the
 * SBOM steps that read the freshly built archive. A promote removes them.
 */
export const BUILD_STEP_KINDS: readonly string[] = [
  "docker-build",
  "zip-package",
  "jvm-build",
  "generate-sbom",
  "extract-config-bom",
];

/**
 * The publish family (the same set COMP001 recognises, plus the
 * `publish-asset` alias). Its output digest is the one a release record binds.
 */
export const PUBLISH_STEP_KINDS: readonly string[] = [
  "publish-image",
  "publish-artifact",
  "publish-asset",
  "load-image-on-host",
];

/** One component a promote will deploy, and the source release it deploys. */
export interface PromotionItem {
  component: string;
  /** The recorded digest being promoted. */
  digest: string;
  /** The source environment's release record the digest came from. */
  source: ReleaseRecord;
}

/** What a promote will do, decided before anything runs. */
export interface PromotionPlan {
  from: string;
  to: string;
  items: PromotionItem[];
  /** Components left alone, and why. Reported, never an error. */
  notPromoted: Array<{ component: string; reason: string }>;
}

/**
 * Pick one release of `component` out of an environment's records: the latest
 * one, or, when `digest` is given, the latest one that recorded that digest.
 * A digest the ledger never recorded for the component is an error.
 */
export function selectRelease(
  records: ReleaseRecord[],
  component: string,
  env: string,
  digest?: string,
): { record: ReleaseRecord } | { error: string } {
  const own = records.filter((r) => r.component === component);
  if (own.length === 0) return { error: `no release of "${component}" is recorded in "${env}"` };
  if (digest === undefined) return { record: latestPerComponent(own).get(component)! };
  const matching = own.filter((r) => r.digest === digest);
  if (matching.length === 0) {
    return {
      error: `digest ${digest} is not recorded for "${component}" in "${env}"; ` +
        `its recorded digests are ${[...new Set(own.map((r) => r.digest))].join(", ")}`,
    };
  }
  return { record: latestPerComponent(matching).get(component)! };
}

/**
 * Decide which releases a promote deploys. With `component`, exactly that
 * component's latest source release (or the one recording `digest`). Without
 * it, the latest source release of every component this checkout declares;
 * a recorded component the checkout no longer declares is reported and left
 * alone, since there is no composition to deploy it with.
 */
export function planPromotion(input: {
  from: string;
  to: string;
  sourceRecords: ReleaseRecord[];
  /** Names of the components this checkout declares. */
  declared: string[];
  component?: string;
  digest?: string;
}): PromotionPlan | { error: string } {
  const { from, to, sourceRecords, declared, component, digest } = input;
  if (from === to) return { error: `--from and --to name the same environment ("${from}")` };
  if (digest !== undefined && component === undefined) {
    return { error: "--digest picks one release of one component, so it needs --component <name>" };
  }

  if (component !== undefined) {
    if (!declared.includes(component)) {
      return { error: `component "${component}" is not declared in this checkout` };
    }
    const picked = selectRelease(sourceRecords, component, from, digest);
    if ("error" in picked) return picked;
    return { from, to, items: [{ component, digest: picked.record.digest, source: picked.record }], notPromoted: [] };
  }

  const latest = latestPerComponent(sourceRecords);
  const items: PromotionItem[] = [];
  const notPromoted: PromotionPlan["notPromoted"] = [];
  for (const [name, record] of [...latest].sort(([a], [b]) => a.localeCompare(b))) {
    if (declared.includes(name)) items.push({ component: name, digest: record.digest, source: record });
    else notPromoted.push({ component: name, reason: "recorded but not declared in this checkout" });
  }
  if (items.length === 0) {
    return { error: `nothing to promote: no component declared here has a release recorded in "${from}"` };
  }
  return { from, to, items, notPromoted };
}

function isGate(step: DriverStep | DriverGate | DriverPhase): step is DriverGate {
  return (step as { kind?: unknown }).kind === "gate";
}

function isPhase(step: DriverStep | DriverGate | DriverPhase): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

/** A component's composition with its build-time steps taken out. */
export interface PromotableComponent {
  component: DriverComponent;
  /** The kinds removed, in composition order. */
  removed: string[];
}

/**
 * Remove every build-time step from `component`'s `deploy` composition and
 * check that what is left can be pinned to one recorded digest. A phase left
 * with nothing to run is dropped. `rollback` phases are untouched.
 */
export function withoutBuildSteps(component: DriverComponent): PromotableComponent | { error: string } {
  const removed: string[] = [];
  /** Phases a build step was removed from, and whether anything else is left in them. */
  const emptied = new Map<string, boolean>();
  let publishSteps = 0;
  const kept: DriverStep[] = [];

  const strip = (phase: DriverPhase): DriverPhase | undefined => {
    const steps: DriverPhase["steps"] = [];
    let lostBuildStep = false;
    for (const step of phase.steps) {
      if (isGate(step)) {
        steps.push(step);
      } else if (isPhase(step)) {
        const nested = strip(step);
        if (nested) steps.push(nested);
      } else if (BUILD_STEP_KINDS.includes(step.kind)) {
        removed.push(step.kind);
        lostBuildStep = true;
      } else {
        if (PUBLISH_STEP_KINDS.includes(step.kind)) publishSteps++;
        kept.push(step);
        steps.push(step);
      }
    }
    const hasWork = steps.some((s) => !isGate(s));
    if (lostBuildStep) emptied.set(phase.phase, !hasWork);
    // A phase holding only gates after the strip still decides them.
    if (steps.length === 0) return undefined;
    return { ...phase, steps };
  };

  const deploy = component.deploy.map(strip).filter((p): p is DriverPhase => p !== undefined);

  if (publishSteps === 0) {
    return {
      error: `component "${component.name}" has no publish step, so nothing in its deploy carries a recorded digest; ` +
        `a promote would deploy whatever its current source produces`,
    };
  }
  if (publishSteps > 1) {
    return {
      error: `component "${component.name}" has ${publishSteps} publish steps, but its release record carries one digest`,
    };
  }
  for (const step of kept) {
    const { kind: _kind, ...fields } = step;
    for (const ref of refsIn(fields)) {
      if (ref.kind === "prior-step" && emptied.get(ref.phaseName) === true) {
        return {
          error: `component "${component.name}" reads "@${ref.phaseName}.${ref.field}", an output of a build step ` +
            `a promote does not run`,
        };
      }
    }
  }
  return { component: { ...component, deploy }, removed };
}

/** Every same-project wiring reference anywhere in a step's fields (cross-stack `stackOutput` objects excluded). */
function refsIn(value: unknown): WiringRef[] {
  const refs: WiringRef[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const ref = parseWiringRef(v);
      if (ref) refs.push(ref);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object" && !("stackOutput" in v)) {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  return refs;
}

/**
 * A registry whose publish-family capabilities check what they published
 * against the digest being promoted for that component. A mismatch fails the
 * step, which fails the component through the driver's ordinary path. Every
 * other capability is passed through untouched.
 */
export function checkPublishedDigest(
  registry: CapabilityRegistry,
  expected: ReadonlyMap<string, string>,
): CapabilityRegistry {
  const checked = new CapabilityRegistry();
  for (const kind of registry.kinds()) {
    const inner = registry.resolve(kind) as Capability<unknown, unknown>;
    if (!PUBLISH_STEP_KINDS.includes(kind)) {
      checked.register(inner);
      continue;
    }
    const wrapped: Capability<unknown, unknown> = {
      kind,
      ...(inner.rollbackPolicy ? { rollbackPolicy: inner.rollbackPolicy } : {}),
      async run(ctx, input) {
        let output: unknown;
        try {
          output = await inner.run(ctx, input);
        } catch (err) {
          throw new Error(
            `${kind} could not publish from the build archive: ${err instanceof Error ? err.message : String(err)}. ` +
              `A promote publishes the archive the source release was built from, so it has to run where that archive is on disk`,
          );
        }
        const want = expected.get(ctx.component);
        const got = (output as { digest?: unknown } | undefined)?.digest;
        if (want !== undefined && got !== want) {
          throw new Error(
            `${kind} published ${typeof got === "string" ? got : "no digest"}, but the release being promoted recorded ${want}; ` +
              `the build archive on disk is not the one that release was built from`,
          );
        }
        return output;
      },
      ...(inner.rollback
        ? { rollback: (ctx, input, output) => inner.rollback!(ctx, input, output) }
        : {}),
    };
    checked.register(wrapped);
  }
  return checked;
}

/** Options for {@link runPromotion}. */
export interface RunPromotionOptions {
  plan: PromotionPlan;
  /** The promotable compositions (see {@link withoutBuildSteps}), one per plan item. */
  components: DriverComponent[];
  registry: CapabilityRegistry;
  componentOutputs?: Record<string, Record<string, unknown>>;
  gates?: GateLedgerPort;
  now?: string;
  onProgress?: (event: RunProgressEvent) => void;
}

/**
 * Deploy the plan's components to `plan.to`, in dependency order. A
 * `dependsOn` edge to a component outside the promotion is dropped, the same
 * way a single-component `chant run --components` runs without its
 * dependencies; their outputs come from `componentOutputs`. Returns the
 * driver's result for every outcome, including a failure.
 */
export async function runPromotion(options: RunPromotionOptions): Promise<DriverRunResult> {
  const { plan } = options;
  const names = new Set(plan.items.map((i) => i.component));
  const targets = options.components
    .filter((c) => names.has(c.name))
    .map((c) => ({ ...c, dependsOn: (c.dependsOn ?? []).filter((d) => names.has(d)) }));
  const expected = new Map(plan.items.map((i) => [i.component, i.digest]));
  try {
    return await runInterpretDriver(targets, checkPublishedDigest(options.registry, expected), {
      env: plan.to,
      componentOutputs: options.componentOutputs ?? {},
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.gates ? { gates: options.gates } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (err) {
    if (err instanceof DriverRunFailure) return err.result;
    throw err;
  }
}

/** Who approved the last gate a component passed in this run, if any. */
export function gateApprover(result: DriverComponentResult | undefined): string | undefined {
  let approver: string | undefined;
  for (const record of result?.records ?? []) {
    if (record.approval) approver = record.approval.resolvedBy;
  }
  return approver;
}

/**
 * The release record a successful promotion appends to the target ledger.
 * The digest, git sha and archive identities are the source release's own,
 * since the artifact is the one built there; `promotedFrom` names that
 * release.
 */
export function promotionRecord(
  item: PromotionItem,
  to: string,
  run: { runId: string; runOrigin?: RunOrigin; actor: string; timestamp: string; approver?: string },
): ReleaseRecordInput {
  const { source } = item;
  return {
    component: item.component,
    env: to,
    digest: item.digest,
    gitSha: source.gitSha,
    runId: run.runId,
    ...(run.runOrigin ? { runOrigin: run.runOrigin } : {}),
    timestamp: run.timestamp,
    actor: run.actor,
    ...(run.approver ? { approver: run.approver } : {}),
    ...(source.manifestDigest ? { manifestDigest: source.manifestDigest } : {}),
    ...(source.inputDigest ? { inputDigest: source.inputDigest } : {}),
    promotedFrom: { env: source.env, runId: source.runId, timestamp: source.timestamp },
  };
}
