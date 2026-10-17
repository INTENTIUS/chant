/**
 * The release gate (#4045, ws-104 questions 2 and 6): the gate `chant
 * components promote --release` passes for an environment.
 *
 * ## What it binds
 *
 * A promote under a release plans the release's change set for the
 * environment it deploys to ({@link planReleaseChangeSet}), stores it on
 * `chant/lifecycle` under its digest (`../lifecycle/gate-change-set.ts`), and
 * decides every gate its components reach against three values:
 *
 * - the change-set document's `digest`, in `planDigest`;
 * - the release, in `releaseDigest`;
 * - the environment, in `environment`.
 *
 * An approval counts only when all three match (`evaluateGate` in
 * `../op/gate.ts`). The document itself names the release and the environment
 * it was planned for, and both are part of its digest, so a stored document
 * names the one release its gate bound and two releases never share a digest.
 *
 * Every gate a promote under a release reaches is recorded in one ledger,
 * {@link RELEASE_GATE_OP}, rather than in each component's. The gate name a
 * composition authors is kept, so components that share a gate name share one
 * gate per environment, and one approval of the release's change set passes
 * each of them. A promote of one component (`--component`) plans that
 * component's subset, which has its own digest and needs its own approval.
 *
 * ## Empty change sets
 *
 * When the change set changes nothing ({@link isEmptyChangeSet}), the
 * promote writes an `empty: true` resolution for each gate, with the actor
 * running it in `resolvedBy` ({@link emptyResolution}). A gate counts it only
 * after it reads the stored document back and finds it empty
 * ({@link emptyVerifier}). Quorum and signing rules don't apply to it.
 *
 * ## The members
 *
 * A component with a step whose capability can plan (`terraform-apply`) is
 * planned by that capability, as a pull request's plan is. A plan that
 * returns no change-set part is a hole, since nothing says what it changes.
 *
 * Any other component is a `chant` member compared with what the
 * environment runs now: its latest deploy record and the release that record
 * names. The artifact digest, each template the release's target records for
 * the component, and the target's parameters are compared, and each one that
 * differs is an attribute of one `update` entry (a `create` when the
 * environment has no deploy of the component). When they are all equal the
 * member has no entries. When the environment's deploy names no release, or
 * the release it names can't be read, the member has a hole: nothing says
 * what the environment runs, so the change can't be shown empty.
 */

import type { CapabilityRegistry } from "./capability";
import { deployContext, resolveComponentGraph, resolveStepInput, type DriverComponent, type DriverGate, type DriverPhase, type DriverStep } from "./driver";
import { componentPlanDigest } from "./gate-plan";
import { gateName, RELEASE_GATE_OP } from "../op/gate-name";
import { capabilitySteps, readComponentOutputs } from "./wave-plan";
import {
  composeChangeSet,
  isEmptyChangeSet,
  type ChangeSetAttribute,
  type ChangeSetDocument,
  type ChangeSetPart,
} from "../change-set";
import type { Release } from "../lifecycle/release-store";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import type { GateResolutionInput } from "../lifecycle/gate-ledger";
import type { StoredChangeSetRead } from "../lifecycle/change-set-store";

/** The gate ledger every release gate is recorded in: `_gates/release.jsonl`, under the member's prefix. */
export { RELEASE_GATE_OP };

/** The address and type a `chant` member's one entry has. */
export const RELEASE_COMPONENT_ENTRY_TYPE = "chant:component";

function isGate(step: DriverStep | DriverGate | DriverPhase): step is DriverGate {
  return (step as { kind?: unknown }).kind === "gate";
}

function isPhase(step: DriverStep | DriverGate | DriverPhase): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

/** The name of every gate the compositions declare, nested phases included, sorted and distinct. */
export function gateNamesOf(components: readonly DriverComponent[]): string[] {
  const names = new Set<string>();
  const walk = (steps: DriverPhase["steps"]): void => {
    for (const step of steps) {
      if (isPhase(step)) walk(step.steps);
      else if (isGate(step)) names.add(gateName(step));
    }
  };
  for (const c of components) for (const phase of c.deploy) walk(phase.steps);
  return [...names].sort();
}

/** What an environment runs of one component now: its latest deploy record, and the release that record names when it can be read. */
export interface CurrentDeploy {
  record: ReleaseRecord;
  release: Release | null;
}

export interface ReleaseChangeSetInput {
  release: Release;
  /** The environment promoted to. */
  env: string;
  /** The promoted compositions, with build steps taken out and templates pinned to the release. */
  components: readonly DriverComponent[];
  /** The artifact digest each component is promoted at. */
  digests: ReadonlyMap<string, string>;
  registry: CapabilityRegistry;
  /** Per component, what `env` runs now. A component missing here has never been deployed to it. */
  current: ReadonlyMap<string, CurrentDeploy>;
  /** Outputs supplied by the caller (`--seed-outputs`). */
  seededOutputs?: Record<string, Record<string, unknown>>;
  /** The chant version to record in the document. */
  chant?: string;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One attribute per key whose value differs between `before` and `after`, sorted by path. */
function differing(before: Map<string, string>, after: Map<string, string>, prefix: string): ChangeSetAttribute[] {
  const out: ChangeSetAttribute[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort(byString)) {
    const was = before.get(key);
    const now = after.get(key);
    if (was === now) continue;
    out.push({ path: `${prefix}${key}`, ...(was !== undefined ? { before: was } : {}), ...(now !== undefined ? { after: now } : {}) });
  }
  return out;
}

/** What one target says a component deploys: its templates by path, and the target's parameters by name. */
function deployedInputs(release: Release, env: string, component: string): { templates: Map<string, string>; params: Map<string, string> } | null {
  const target = release.targets.find((t) => t.env === env);
  if (!target) return null;
  return {
    templates: new Map(target.templates.filter((t) => t.component === component).map((t) => [t.path, t.digest])),
    params: new Map(target.params.map((p) => [p.name, JSON.stringify(p.value)])),
  };
}

/**
 * A component no capability plans, as a `chant` member: what the release
 * deploys compared with what the environment runs now. See the module doc.
 */
export function chantComponentPart(input: {
  component: DriverComponent;
  release: Release;
  env: string;
  digest: string;
  current: CurrentDeploy | undefined;
}): ChangeSetPart {
  const { component, release, env, digest, current } = input;
  const name = component.name;
  const member = {
    member: name,
    lexicon: "chant",
    planner: "chant" as const,
    status: "planned" as const,
    planDigest: componentPlanDigest({ environment: env, component, release: digest }),
    holes: [] as Array<{ address: string; type?: string; reason: string }>,
  };
  const want = deployedInputs(release, env, name);
  if (!want) {
    member.holes.push({ address: name, type: RELEASE_COMPONENT_ENTRY_TYPE, reason: `release ${release.releaseDigest} has no target for "${env}"` });
    return { member, entries: [] };
  }
  const entry = (action: "create" | "update", attributes: ChangeSetAttribute[]): ChangeSetPart => ({
    member,
    entries: [
      {
        member: name,
        lexicon: "chant",
        planner: "chant",
        address: name,
        type: RELEASE_COMPONENT_ENTRY_TYPE,
        name,
        action,
        ...(action === "update" ? { disruption: "unknown" as const } : {}),
        scope: env,
        attributes,
      },
    ],
  });
  if (!current) {
    return entry("create", [
      { path: "artifact", after: digest },
      ...differing(new Map(), want.templates, "template:"),
      ...differing(new Map(), want.params, "param:"),
    ]);
  }
  const named = current.record.releaseDigest;
  if (named === undefined) {
    member.holes.push({
      address: name,
      type: RELEASE_COMPONENT_ENTRY_TYPE,
      reason: `the "${env}" deploy of ${name} (run ${current.record.runId}) names no release, so what it runs can't be compared with this release`,
    });
    return { member, entries: [] };
  }
  const have = current.release ? deployedInputs(current.release, env, name) : null;
  if (!have) {
    member.holes.push({
      address: name,
      type: RELEASE_COMPONENT_ENTRY_TYPE,
      reason: current.release
        ? `release ${named}, which the "${env}" deploy of ${name} names, has no target for "${env}"`
        : `release ${named}, which the "${env}" deploy of ${name} names, can't be read from chant/lifecycle`,
    });
    return { member, entries: [] };
  }
  const attributes = [
    ...differing(new Map([["", current.record.digest]]), new Map([["", digest]]), "artifact"),
    ...differing(have.templates, want.templates, "template:"),
    ...differing(have.params, want.params, "param:"),
  ];
  return attributes.length === 0 ? { member, entries: [] } : entry("update", attributes);
}

/**
 * Plan the release's change set for `env`: one part per promoted component
 * (or per member its planning capability names), composed into a document
 * that names the release and the environment. Never throws for a component
 * that fails to plan: it becomes a failed member.
 */
export async function planReleaseChangeSet(input: ReleaseChangeSetInput): Promise<ChangeSetDocument> {
  const { release, env, registry } = input;
  const components = [...input.components];
  const byName = new Map(components.map((c) => [c.name, c]));
  const outputs: Record<string, Record<string, unknown>> = { ...(input.seededOutputs ?? {}) };
  const read = new Set(Object.keys(outputs));
  const parts: ChangeSetPart[] = [];
  const { order } = resolveComponentGraph(components.map((c) => ({ ...c, dependsOn: (c.dependsOn ?? []).filter((d) => byName.has(d)) })));
  for (const name of order) {
    const component = byName.get(name)!;
    const digest = input.digests.get(name) ?? "";
    const plannable = capabilitySteps(component.deploy).filter((s) => registry.has(s.kind) && registry.resolve(s.kind).plan !== undefined);
    if (plannable.length === 0) {
      parts.push(chantComponentPart({ component, release, env, digest, current: input.current.get(name) }));
      continue;
    }
    const ctx = deployContext({ env }, name);
    try {
      for (const dep of component.dependsOn ?? []) {
        if (read.has(dep) || !byName.has(dep)) continue;
        read.add(dep);
        const found = await readComponentOutputs(byName.get(dep)!, registry, deployContext({ env }, dep), outputs);
        if (found) outputs[dep] = found;
      }
      for (const step of plannable) {
        const { kind, ...rest } = step;
        const planned = await registry.resolve(kind).plan!(ctx, resolveStepInput(rest, {}, outputs) as never);
        parts.push(
          planned.changeSet ?? {
            member: {
              member: planned.member,
              lexicon: "chant",
              planner: "chant",
              status: "planned",
              planDigest: planned.planDigest,
              holes: [{ address: planned.member, reason: `its ${kind} plan describes no changes, so what it changes is unknown` }],
            },
            entries: [],
          },
        );
      }
    } catch (err) {
      parts.push({
        member: {
          member: name,
          lexicon: "chant",
          planner: "chant",
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          planDigest: null,
          holes: [],
        },
        entries: [],
      });
    }
  }
  return composeChangeSet(parts, {
    ...(input.chant !== undefined ? { chant: input.chant } : {}),
    planned: { releaseDigest: release.releaseDigest, environment: env },
  });
}

/** The members a release gate refuses: provisional ones, which no approval of the document covers (`change-set.mdx`). */
export function provisionalMembers(doc: ChangeSetDocument): string[] {
  return doc.members.filter((m) => m.provisional === true).map((m) => m.member);
}

/**
 * The `verifyEmpty` a release gate decides with: the document stored under
 * the digest, read back and checked against its digest by `read`, is the
 * one planned for this release and environment, and it is empty.
 */
export function emptyVerifier(
  read: (digest: string) => Promise<StoredChangeSetRead>,
  planned: { releaseDigest: string; environment: string },
): (digest: string) => Promise<boolean> {
  return async (digest) => {
    const stored = await read(digest);
    return (
      stored.status === "found" &&
      stored.document.releaseDigest === planned.releaseDigest &&
      stored.document.environment === planned.environment &&
      isEmptyChangeSet(stored.document)
    );
  };
}

/** The `empty: true` resolution a promote writes for one release gate over an empty change set. */
export function emptyResolution(input: {
  gate: string;
  doc: ChangeSetDocument;
  actor: string;
  timestamp: string;
  gitSha?: string;
  runId?: string;
}): GateResolutionInput {
  const { doc } = input;
  if (doc.releaseDigest === undefined || doc.environment === undefined) {
    throw new Error(`change set ${doc.digest} names no release and environment, so no release gate can pass on it`);
  }
  return {
    op: RELEASE_GATE_OP,
    gate: input.gate,
    resolvedBy: input.actor,
    timestamp: input.timestamp,
    note: `the change set of release ${doc.releaseDigest} for "${doc.environment}" is empty`,
    planDigest: doc.digest,
    environment: doc.environment,
    releaseDigest: doc.releaseDigest,
    empty: true,
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  };
}
