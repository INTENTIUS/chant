/**
 * `terraform-apply`'s group methods (chant#4447, ws-107): core forms a group
 * of `terraform-apply` components that read each other, and these plan it
 * as one plan and apply it as one apply of a composed root, so a value one
 * root creates reaches its readers inside that apply.
 *
 * - `groupFallback` answers `off` while `terraform.compose.enabled` is unset,
 *   else builds the {@link Composition} (#4438) from the files, the config
 *   and each member's cloud identity, and answers its fallback, if any. A
 *   member the composition leaves out is dropped with its own kind and
 *   reason, and core forms the group again from the rest (#4419 ruling 1).
 *   A composition of estates also asks `choudoufu version` (#4445).
 *   Nothing plans.
 * - `planGroup` builds the composition again, plans it once with
 *   `ComposedRun` (#4444) or, for estates, `EstateRun` (#4445), and answers
 *   each member's part (#4442): its change-set part, planned outputs and
 *   shape, with its own plan's digest. The group's digest is the composed
 *   plan's with the generated files. The run is released before it returns,
 *   with no lock taken, so a plan that core then refuses or makes wait
 *   leaves no lock held and no file changed.
 * - `runGroup` plans once more, this time under each state's lock, and
 *   applies only when that plan's digest is the one `planGroup` answered;
 *   otherwise it throws a moved plan and nothing applies. Whatever happens,
 *   it releases the run. Each member's outputs come from the run: its part
 *   of the working state's `show -json` for roots with state, the post-apply
 *   plan's `prior_state` for estates.
 *
 * Each member's identity is `ci.identity.cloud` resolved for its root as
 * the target (`resolveTargetCloudIdentity`, #4332), compared by
 * `identityKey`, so members that apply under different identities do not
 * compose (#4438's `identity`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadChantConfigUpward } from "@intentius/chant/config";
import type { PipelineCloudIdentity } from "@intentius/chant/ci-identity";
import type {
  CapabilityGroupOutcome,
  CapabilityGroupPlan,
  CapabilityPlan,
  GroupContext,
  GroupDrop,
  GroupFallback,
  GroupMember,
  GroupMemberOutcome,
  GroupRun,
} from "@intentius/chant/components/capability";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { wiringReferencesAt } from "@intentius/chant/components/driver";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { declaredTargetCloudIdentity } from "@intentius/chant/workspace/ci-cloud-identity";
import { COMPOSE_STEP_KIND, composeOff, compositionFor, identityKey, type Composition } from "../compose";
import type { TerraformConfig } from "../config";
import { terraformBinary, terraformOutputs } from "../op/activities/terraform";
import { runBinary, type BinaryExec } from "../state/exec";
import { estateVersionFallback, EstateRun, type ComposedRunner } from "../compose/estate";
import { ComposedRun } from "../compose/run";

/** The step input as the group methods read it; `TerraformApplyStepInput` in ./capability-plugin.ts. */
interface StepInput {
  root: string;
  vars?: Record<string, unknown>;
  cwd?: string;
}

/** The project a group's roots belong to. */
export interface ComposeProject {
  /** Where `chant.config.*` was found: roots resolve against it and `.chant-compose/` is written there. */
  projectRoot: string;
  terraform: TerraformConfig;
}

/** What a runner is built from. */
export interface GroupRunnerOptions extends ComposeProject {
  composition: Composition;
  /** Take each state's lock: `runGroup` does, `planGroup` does not. */
  lock: boolean;
  /** Each member's step `vars` as written, by component. */
  vars: Record<string, Record<string, unknown> | undefined>;
  /** The outputs of components outside the group that a member's `vars` read. */
  componentOutputs: Record<string, Record<string, unknown>>;
  env: NodeJS.ProcessEnv;
  /** A directory of the run's own, removed after the run is released. */
  work: string;
}

/** What `planGroup` hands `runGroup` through `GroupRun.artifact`. */
interface ComposedArtifact {
  /** The composed plan's digest `planGroup` answered (`CapabilityGroupPlan.digest`). */
  digest: string;
  estate: boolean;
}

/** What the group methods use, each replaceable in a test. */
export interface ComposeGroupDeps {
  /** The project's config. Default: `loadChantConfigUpward` from the current directory. */
  project?: () => Promise<ComposeProject>;
  /** The run for a composition. Default: `EstateRun` when `estate` is set, else `ComposedRun`. */
  runner?: (o: GroupRunnerOptions) => ComposedRunner;
  /**
   * Each target's cloud identity for `env` (`resolveTargetCloudIdentity`,
   * #4332), or undefined when there is no workspace to read. Default:
   * `declaredTargetCloudIdentity` from the project root.
   */
  identity?: (projectRoot: string, env: string) => Promise<((target: string) => PipelineCloudIdentity | undefined) | undefined>;
  /** How `choudoufu version` runs. Default `runBinary`. */
  exec?: BinaryExec;
  /** A root's outputs as its state holds them, for a member whose part of the working state could not be shown. Default `terraformOutputs`. */
  outputs?: (root: string) => Promise<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** The group methods `terraform-apply` declares. */
export interface ComposeGroupMethods {
  groupFallback(ctx: GroupContext, members: readonly GroupMember<StepInput>[]): Promise<GroupFallback | undefined>;
  planGroup(ctx: GroupContext, members: readonly GroupMember<StepInput>[]): Promise<CapabilityGroupPlan>;
  runGroup(ctx: GroupContext, run: GroupRun, members: readonly GroupMember<StepInput>[]): Promise<CapabilityGroupOutcome>;
}

async function loadProject(): Promise<ComposeProject> {
  const start = resolve(process.cwd());
  const { config, configPath } = await loadChantConfigUpward(start);
  const projectRoot = configPath ? dirname(configPath) : start;
  const terraform = (config as { terraform?: TerraformConfig }).terraform;
  return { projectRoot, terraform: { ...(terraform ?? {}), roots: terraform?.roots ?? {} } as TerraformConfig };
}

function defaultRunner(o: GroupRunnerOptions, log?: (line: string) => void): ComposedRunner {
  if (o.composition.estate) {
    return new EstateRun({ projectRoot: o.projectRoot, composition: o.composition, terraform: o.terraform, env: o.env, work: o.work, ...(log ? { log } : {}) });
  }
  return new ComposedRun({
    projectRoot: o.projectRoot,
    composition: o.composition,
    terraform: o.terraform,
    binary: { path: terraformBinary(o.terraform) },
    env: o.env,
    work: o.work,
    lock: o.lock,
    ...(o.env.GITHUB_RUN_ID ? { runId: `github-run-${o.env.GITHUB_RUN_ID}` } : {}),
    vars: o.vars,
    componentOutputs: o.componentOutputs,
    // A state that could not be written is kept here when its backend cannot take it; it outlives the run's own directory.
    reportDir: join(o.projectRoot, ".chant", "compose", "unwritten"),
    ...(log ? { log } : {}),
  });
}

/** The members as components, each deploying its one step, for `compositionFor`. */
export function memberComponents(members: readonly GroupMember<StepInput>[]): DriverComponent[] {
  return members.map((m) => ({
    name: m.component,
    ...(m.dependsOn ? { dependsOn: [...m.dependsOn] } : {}),
    deploy: [{ phase: "Apply", steps: [{ ...m.step, kind: COMPOSE_STEP_KIND }] }],
  }));
}

/**
 * Each member's identity as `compositionFor` compares it: `identityKey` of
 * `lookup` for the member's root. Undefined without a lookup, so no member
 * falls back as `identity`.
 */
export function memberIdentity(
  members: readonly GroupMember<StepInput>[],
  lookup: ((target: string) => PipelineCloudIdentity | undefined) | undefined,
): ((member: string) => string | undefined) | undefined {
  if (!lookup) return undefined;
  const keys = new Map(members.map((m) => [m.component, identityKey(lookup(m.step.root as string))] as const));
  return (member) => keys.get(member);
}

/** The composition of exactly the group's members (core has already formed the group). */
export function groupComposition(
  project: ComposeProject,
  members: readonly GroupMember<StepInput>[],
  env: NodeJS.ProcessEnv,
  identity?: (member: string) => string | undefined,
): Composition {
  const targets = Object.fromEntries(members.flatMap((m) => (m.ctx.targets?.length ? [[m.component, m.ctx.targets] as const] : [])));
  return compositionFor({
    projectRoot: project.projectRoot,
    terraform: project.terraform,
    components: memberComponents(members),
    selected: new Set(members.map((m) => m.component)),
    env,
    targets,
    ...(identity ? { identity } : {}),
  });
}

/**
 * What core is told of the group (#4419 ruling 1): the whole change's
 * fallback when it is not `one-root`; else each member the composition left
 * out as a drop with its own kind and reason, so core groups the rest
 * again without them; else `one-root`. Undefined when every member
 * composes.
 */
export function groupFallbackOf(c: Composition, members: readonly string[]): GroupFallback | undefined {
  if (c.fallback && c.fallback.kind !== "one-root") return { kind: c.fallback.kind, reason: c.fallback.reason };
  const drop: GroupDrop[] = c.fallbacks.flatMap((f) => (f.member !== undefined && members.includes(f.member) ? [{ component: f.member, kind: f.kind, reason: f.reason }] : []));
  if (!c.fallback) {
    const named = new Set(drop.map((d) => d.component));
    for (const m of members) {
      if (!named.has(m) && !c.members.includes(m)) drop.push({ component: m, kind: "path", reason: `\`${m}\` deploys no root the composition could read` });
    }
  }
  if (drop.length > 0) return { kind: drop[0]!.kind!, reason: drop[0]!.reason!, drop };
  if (c.fallback) return { kind: c.fallback.kind, reason: c.fallback.reason };
  return undefined;
}

/** `value` at the JSON Pointer `at`. */
function atPointer(value: unknown, at: string): unknown {
  if (at === "") return value;
  return at
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]), value);
}

/** Set `value` at the dotted `path` of `target`. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let at = target;
  for (const k of keys.slice(0, -1)) {
    const next = at[k];
    at = (next && typeof next === "object" ? next : (at[k] = {})) as Record<string, unknown>;
  }
  at[keys[keys.length - 1]!] = value;
}

/**
 * The outputs of components outside the group that the members' `vars`
 * read, recovered from each member's input, which core resolved against
 * them: `writeComposedRoot` turns those reads into literals.
 */
export function outsideOutputs(members: readonly GroupMember<StepInput>[]): Record<string, Record<string, unknown>> {
  const inGroup = new Set(members.map((m) => m.component));
  const out: Record<string, Record<string, unknown>> = {};
  for (const m of members) {
    for (const r of wiringReferencesAt(m.step)) {
      if (inGroup.has(r.source)) continue;
      const value = atPointer(m.input, r.at);
      if (value !== undefined) setPath((out[r.source] ??= {}), r.output, value);
    }
  }
  return out;
}

/** The members' unresolved reads of components outside the group, by member. */
function unresolvedOf(members: readonly GroupMember<StepInput>[]): Map<string, string[]> {
  return new Map(members.flatMap((m) => (m.ctx.unresolvedInputs?.length ? [[m.component, [...m.ctx.unresolvedInputs].sort()] as const] : [])));
}

/**
 * The group while a member reads an output of a component outside it that
 * is not known yet: no member is planned, each gets a hole naming what the
 * group waits on, and core plans the group again once those apply.
 */
function waitingGroup(ctx: GroupContext, members: readonly GroupMember<StepInput>[], unresolved: ReadonlyMap<string, string[]>): CapabilityGroupPlan {
  const waits = [...new Set([...unresolved.values()].flat())].sort();
  const by = [...unresolved.keys()].sort();
  const plans: Record<string, CapabilityPlan> = {};
  for (const m of members) {
    const root = m.step.root as string;
    const vars = Object.fromEntries(Object.entries((m.input?.vars ?? {}) as Record<string, unknown>).map(([k, v]) => [k, v === undefined ? null : v]));
    const planDigest = computePlanDigest("terraform-apply-group-unresolved", { env: ctx.env, root, vars, unresolved: waits });
    const reason =
      by.length === 1 && by[0] === m.component
        ? `inputs from ${waits.join(", ")}; planned again once they apply`
        : `inputs from ${waits.join(", ")}, read by ${by.join(", ")} in its group; planned again once they apply`;
    const changeSet: ChangeSetPart = {
      member: { member: root, lexicon: "terraform", planner: "chant", status: "planned", planDigest, holes: [{ address: root, type: "terraform_root", reason }] },
      entries: [],
    };
    plans[m.component] = { member: root, planDigest, changeSet };
  }
  return { members: plans, digest: computePlanDigest("terraform-apply-group-unresolved", { components: ctx.components, unresolved: waits }) };
}

/** A composed plan that no longer matches the one approved. Core's moved-plan mark, so nothing applies and the command exits 3. */
export class ComposedPlanMovedError extends Error {
  readonly planMoved = true;
  constructor(message: string) {
    super(message);
    this.name = "ComposedPlanMovedError";
  }
}

/** The group methods, with `deps` in place of the defaults. */
export function composeGroup(deps: ComposeGroupDeps = {}): ComposeGroupMethods {
  const project = deps.project ?? loadProject;
  const exec = deps.exec ?? runBinary;
  const envOf = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.error(line));
  const readOutputs = deps.outputs ?? ((root: string) => terraformOutputs({ root }));
  const identities = deps.identity ?? declaredTargetCloudIdentity;

  /** The composition of `members` as `groupFallback` judges it, with each member's identity. */
  async function compositionOf(ctx: GroupContext, p: ComposeProject, members: readonly GroupMember<StepInput>[]): Promise<Composition> {
    const lookup = await identities(p.projectRoot, ctx.env);
    return groupComposition(p, members, envOf(), memberIdentity(members, lookup));
  }

  /** The composition the group plans as, or throws when it does not compose. */
  async function composed(ctx: GroupContext, members: readonly GroupMember<StepInput>[]): Promise<{ p: ComposeProject; c: Composition }> {
    const p = await project();
    const off = composeOff(p.terraform);
    if (off) throw new Error(off.reason);
    const c = await compositionOf(ctx, p, members);
    const refused = groupFallbackOf(c, members.map((m) => m.component));
    if (refused) throw new Error(`the group no longer composes: ${refused.reason}`);
    return { p, c };
  }

  /** Build a runner, run `fn` on it, and release it and its directory whatever happened. */
  async function withRunner<T>(p: ComposeProject, c: Composition, members: readonly GroupMember<StepInput>[], lock: boolean, fn: (r: ComposedRunner) => Promise<T>): Promise<T> {
    const work = mkdtempSync(join(tmpdir(), "chant-compose-"));
    const o: GroupRunnerOptions = {
      ...p,
      composition: c,
      lock,
      vars: Object.fromEntries(members.map((m) => [m.component, m.step.vars as Record<string, unknown> | undefined])),
      componentOutputs: outsideOutputs(members),
      env: envOf(),
      work,
    };
    const runner = deps.runner ? deps.runner(o) : defaultRunner(o, log);
    try {
      return await fn(runner);
    } finally {
      try {
        await runner.release();
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
  }

  return {
    async groupFallback(ctx, members) {
      const p = await project();
      const off = composeOff(p.terraform);
      if (off) return { kind: off.kind, reason: off.reason };
      const c = await compositionOf(ctx, p, members);
      // A member left out is dropped alone; core asks again with the rest, and the estate check runs then.
      const refused = groupFallbackOf(c, members.map((m) => m.component));
      if (refused) return refused;
      if (c.estate) {
        const binary = p.terraform.binary ?? "choudoufu";
        const v = await exec(binary, ["version"], p.projectRoot, envOf());
        // A binary that cannot say its version is left to the plan, which says why it fails.
        const old = v.code === 0 ? estateVersionFallback(v.stdout) : undefined;
        if (old) return { kind: old.kind, reason: old.reason };
      }
      return undefined;
    },

    async planGroup(ctx, members) {
      const unresolved = unresolvedOf(members);
      if (unresolved.size > 0) return waitingGroup(ctx, members, unresolved);
      const { p, c } = await composed(ctx, members);
      // Planned without locks and released at once: nothing stays held or changed if core refuses the plan or makes it wait.
      const planned = await withRunner(p, c, members, false, (r) => r.plan());
      if (planned.fallback) throw new Error(`the group no longer composes: ${planned.fallback.reason}`);
      if (planned.error) throw new Error(planned.error);
      const plans: Record<string, CapabilityPlan> = {};
      for (const m of members) {
        const part = planned.members[m.component];
        if (!part) throw new Error(`the composed plan has no part for ${m.component}`);
        plans[m.component] = { member: part.member, planDigest: part.planDigest, changeSet: part.changeSet, outputs: part.outputs, shape: part.shape };
      }
      const artifact: ComposedArtifact = { digest: planned.digest, estate: c.estate === true };
      return { members: plans, digest: planned.digest, artifact };
    },

    async runGroup(ctx, run, members) {
      if (unresolvedOf(members).size > 0) throw new Error("the group reads outputs of components outside it that are not known yet, so it cannot apply");
      const approved = run.artifact as ComposedArtifact | undefined;
      if (typeof approved?.digest !== "string" || approved.digest === "") throw new Error("no composed plan of the group to apply");
      const { p, c } = await composed(ctx, members);
      const notStarted = (error: string): CapabilityGroupOutcome => ({
        members: Object.fromEntries(members.map((m) => [m.component, { status: "not-started" as const, error }])),
        error,
      });
      const applied = await withRunner(p, c, members, true, async (r) => {
        // The approved plan was made without locks; plan again under them, and apply only that same plan.
        const planned = await r.plan();
        if (planned.fallback) return notStarted(`the group no longer composes: ${planned.fallback.reason}`);
        if (planned.error) return notStarted(planned.error);
        if (planned.digest !== approved.digest) {
          throw new ComposedPlanMovedError(`the composed plan moved since it was approved (approved ${approved.digest}, planned now ${planned.digest}), so nothing applied`);
        }
        return r.apply();
      });
      const out: Record<string, GroupMemberOutcome> = {};
      for (const m of members) {
        const o = applied.members[m.component] as (GroupMemberOutcome & { lockHeld?: true; kept?: string }) | undefined;
        if (!o) {
          out[m.component] = { status: "failed", error: applied.error ?? `the composed apply said nothing of ${m.component}` };
          continue;
        }
        let outputs = o.outputs;
        // A root's state is written by now; read its outputs from there when its part of the working state could not be shown.
        if (!outputs && !c.estate && (o.status === "applied" || o.status === "no-changes")) {
          outputs = await readOutputs(m.step.root as string).catch(() => undefined);
        }
        const held = o.lockHeld ? `its state was kept unwritten${o.kept ? ` at ${o.kept}` : ""}, and its lock stays held until a later run writes it` : undefined;
        const error = [o.error, held].filter(Boolean).join("; ");
        out[m.component] = { status: o.status, ...(outputs ? { outputs } : {}), ...(error ? { error } : {}) };
      }
      return { members: out, ...(applied.error ? { error: applied.error } : {}) };
    },
  };
}

/** The group methods `terraform-apply` uses. */
export const terraformComposeGroup: ComposeGroupMethods = composeGroup();
