/**
 * `pulumi-up`, the pulumi lexicon's apply capability (#4541): a Pulumi or
 * plunge stack as a component step that plans and applies, the way
 * `terraform-apply` does a root. Ruling 1 on INTENTIUS/plywood#1 widened
 * #4450 and #4476 so chant runs `up`, from an apply job holding the apply
 * identity only; the argv go through `runApplyPulumi` and `runApplyPlunge`
 * (`./run.ts`), each one fixed form.
 *
 * The step is `{ kind: "pulumi-up", dir, stack }`, with optional `member`,
 * `config`, `engine`, `cwd`, `lockGrain` and `policyPacks`. One kind covers
 * both engines; `pulumiMemberEngine` (`./member-engine.ts`, #4559) picks
 * the binary from the step's `engine`, `plywood.yml`, `PULUMI_BACKEND_URL`
 * or `Pulumi.yaml`, and the artifact records which rule answered.
 *
 * ## plan
 *
 * The preview runs with `PULUMI_ENABLE_STREAMING_JSON_PREVIEW=true` (ruling
 * C), so one engine run gives the change set and CrossGuard's verdict
 * (`./engine-events.ts`). On plunge it also writes `--save-plan` into a
 * scratch directory under the OS temp dir, never the working tree, since the
 * file holds secret ciphertext. The plan answers:
 *
 * - `member`: `<member>/<stack>`, the name in the wave's set digest;
 * - `planDigest` and `changeSet` from `pulumiPreviewPart`; for a member on
 *   the resource lock grain (`lockGrain`, default `resource` on plunge and
 *   `target` on stock Pulumi, as #4552 rules) the digest leaves `same` and
 *   `read` steps out (ruling B);
 * - `outputs` from the stack step's planned outputs;
 * - `shape` from `pulumiPlanShape` (`./plan-shape.ts`);
 * - `artifact`: the engine, the shape, the digest, CrossGuard's findings,
 *   and on plunge the plan file.
 *
 * A mandatory CrossGuard violation, or a preview Pulumi fails with its
 * policy code, throws {@link PulumiPolicyDeniedError}: no gate opens. Any
 * other failed preview throws, naming the engine's error.
 *
 * With `DeployContext.unresolvedInputs` set the member is a hole naming the
 * upstreams it waits on, as `terraform-apply`'s `waitingRoot` is. A stand-in
 * preview is later work.
 *
 * ## run
 *
 * - plunge, with the plan's artifact: `plunge up --plan <file> --yes --json
 *   --stack <s>`. plunge checks the plan's stamp and refuses a plan whose
 *   records moved, or one with no stamp, before anything changes (exit 40),
 *   which throws {@link PulumiPlanMovedError}: the table's moved code, 4.
 * - stock Pulumi, with the artifact: preview again and throw core's
 *   `PlanShapeMovedError` when the fresh shape goes beyond the approved one;
 *   then `pulumi up --yes --json --stack <s>`, and compare the steps in its
 *   event stream with the approved shape (ruling A). A difference fails the
 *   step with {@link PulumiAppliedShapeError}, whose message the apply
 *   record keeps. It is failed, never moved: resources changed.
 * - no approved plan (`chant run --components`, a release promote, a fan-out
 *   with no wave gate): preview and `up` in one go (ruling D), as
 *   `terraform-apply` does with no plan.
 *
 * Every engine exit goes through `pulumiExitOf` (`./exit-codes.ts`, #4553):
 * plunge's 40 is moved, Pulumi's policy code is denied, anything else is
 * failed with the stream's error and the URNs that landed.
 *
 * After `up`, the stack's outputs come from `stack output --json
 * --show-secrets=false`, secrets as `[secret]`. The stack export write is
 * #4546's.
 *
 * ## config
 *
 * `config` (a dependent's `stackOutput()` wiring) is written into a scratch
 * copy of `Pulumi.<stack>.yaml` and passed with `--config-file`; `--config`
 * is never used, since it saves into the working tree's file. A key with no
 * `:` is the project's own (`<project>:<key>`).
 *
 * ## releases (#4542)
 *
 * `releaseInputs` answers the stack's directory, so a release cut records it
 * and a promote or rollback under the release previews and applies the
 * recorded copy. A stack whose backend is a file path relative to its
 * directory is unbound: a copy elsewhere would read no state.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type { Capability, CapabilityPlan, DeployContext, ReleaseInputs, ReleaseInputsContext, ReleaseInputsUnbound } from "@intentius/chant/components/capability";
import { PlanShapeMovedError, type PlanShape } from "@intentius/chant/components/covered-round";
import type { GatePolicyFindings } from "@intentius/chant/gate-policy";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { parseYAML } from "@intentius/chant/yaml";
import { pulumiPreviewPart } from "./change-set";
import {
  PULUMI_STREAMING_PREVIEW_ENV,
  pulumiAppliedSteps,
  pulumiFailedUrns,
  pulumiLandedUrns,
  pulumiPolicyEvents,
  pulumiPolicyFindings,
  pulumiStreamError,
  pulumiStreamPreview,
  pulumiStreamSummary,
  type PulumiApplySummary,
} from "./engine-events";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { pulumiExitOf } from "./exit-codes";
import { pulumiMemberEngine, type PulumiMemberEngine, type PulumiMemberEngineSource } from "./member-engine";
import { pulumiMemberPlannedOutputs } from "./member-outputs";
import { pulumiPlanShape, pulumiShapeDifferences } from "./plan-shape";
import {
  defaultPlungeRunner,
  defaultPulumiRunner,
  plungeUpArgs,
  pulumiMemberStackOutputs,
  pulumiRunFailure,
  pulumiUpArgs,
  pulumiUpPreviewArgs,
  readMemberExport,
  runAllowedPlunge,
  runAllowedPulumi,
  runApplyPlunge,
  runApplyPulumi,
  type PulumiPolicyPack,
  type PulumiRunner,
} from "./run";
import type { PulumiStep } from "./change-set";

/** The lock grain values of `ci.lockGrain` (#4552's ruling A). */
export type PulumiLockGrain = "target" | "resource" | "repo";

/** The `pulumi-up` step's input. */
export interface PulumiUpStepInput {
  /** The stack's directory, where `Pulumi.yaml` is. Relative paths resolve against `cwd`. */
  dir: string;
  /** The stack to preview and apply, passed as `--stack`. */
  stack: string;
  /** The member's name in the set digest. Default: `Pulumi.yaml`'s `name`, else the directory's name. */
  member?: string;
  /** Stack config values, written into a scratch copy of `Pulumi.<stack>.yaml` (never `--config`). */
  config?: Record<string, unknown>;
  /** `pulumi` or `plunge`; see `pulumiMemberEngine`. */
  engine?: PulumiMemberEngine;
  /** Where a relative `dir` resolves from. Default: the process's working directory. */
  cwd?: string;
  /** The member's `ci.lockGrain` (#4552). Default: `resource` on plunge, `target` on stock Pulumi. */
  lockGrain?: PulumiLockGrain;
  /** CrossGuard packs for the preview and `up` (ruling 7). */
  policyPacks?: PulumiPolicyPack[];
}

/** What `run` returns. */
export interface PulumiUpStepOutput {
  /** `<member>/<stack>`. */
  member: string;
  stack: string;
  engine: PulumiMemberEngine;
  planDigest: string;
  /** Whether `run` applied the plan the wave handed it, rather than one it made itself. */
  fromWavePlan: boolean;
  /** `stack output --json --show-secrets=false` after `up`, secrets as `[secret]`. */
  outputs: Record<string, unknown>;
  /** The `summaryEvent` of `up --json`, with plunge's timings when present. */
  summary?: PulumiApplySummary;
  /** CrossGuard's findings from the preview the apply ran under. */
  policy?: GatePolicyFindings;
}

/** What `plan` hands `run` through `DeployContext.plans[member]`. */
export interface PulumiUpArtifact {
  kind: "pulumi-up";
  member: string;
  stack: string;
  engine: PulumiMemberEngine;
  /** The rule `pulumiMemberEngine` answered with (#4559), for the plan output. */
  engineSource: PulumiMemberEngineSource;
  engineBecause: string;
  planDigest: string;
  shape: PlanShape;
  /** The scratch directory holding the plan file and config copy. */
  scratch: string;
  /** plunge's saved plan. plunge only. */
  planFile?: string;
  /** The scratch copy of the stack's config, when the step has `config`. */
  configFile?: string;
  /** CrossGuard's findings from the plan's preview. */
  policy: GatePolicyFindings;
}

/** plunge refused a saved plan whose records moved, or one with no stamp (exit 40). `planMoved` is core's moved mark. */
export class PulumiPlanMovedError extends Error {
  readonly planMoved = true;
  constructor(
    public readonly member: string,
    message: string,
  ) {
    super(message);
    this.name = "PulumiPlanMovedError";
  }
}

/** CrossGuard denied the plan: a mandatory violation, or the engine's policy exit. No gate opens. */
export class PulumiPolicyDeniedError extends Error {
  readonly policyDenied = true;
  /** The table's code for it (#4553, ruling B: 7 everywhere). */
  readonly exitCode = CHANT_EXIT.denied;
  constructor(
    public readonly member: string,
    public readonly findings: GatePolicyFindings,
    detail?: string,
  ) {
    const denied = findings.denials.map((d) => `${d.rule}: ${d.message}`).join("; ");
    super(`"${member}": CrossGuard denied the plan${denied ? `: ${denied}` : ""}${detail ? ` (${detail})` : ""}`);
    this.name = "PulumiPolicyDeniedError";
  }
}

/**
 * A stock `pulumi up` ran steps the approved shape does not hold (ruling A).
 * The update has run, so this is a failure, not a moved plan: the step fails
 * and the differences land on the apply record through the message.
 */
export class PulumiAppliedShapeError extends Error {
  constructor(
    public readonly member: string,
    public readonly differences: string[],
    public readonly summary?: PulumiApplySummary,
  ) {
    super(`"${member}": pulumi up ran steps the approved plan did not hold: ${differences.join("; ")}. The update ran; check the stack and plan it again.`);
    this.name = "PulumiAppliedShapeError";
  }
}

/** A stock Pulumi member set to the resource grain (#4552): the backend's stack lock already orders its updates. */
export class PulumiResourceGrainRefusedError extends Error {
  constructor(public readonly member: string) {
    super(`"${member}": the resource lock grain needs plunge; a stock Pulumi stack keeps the stack grain, since its backend's stack lock orders updates (ci.lockGrain: target)`);
    this.name = "PulumiResourceGrainRefusedError";
  }
}

/** The default lock grain for an engine (#4552's design): resource on plunge, the stack (target) on stock Pulumi. */
export function pulumiDefaultLockGrain(engine: PulumiMemberEngine): PulumiLockGrain {
  return engine === "plunge" ? "resource" : "target";
}

/** Runners and scratch, injectable so the tests run no binary. */
export interface PulumiUpOptions {
  run?: PulumiRunner;
  plunge?: PulumiRunner;
  /** The job environment the engine is picked from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Where scratch directories go. Default: the OS temp dir. */
  tmp?: string;
}

const STREAMING = { [PULUMI_STREAMING_PREVIEW_ENV]: "true" };

function stackDir(input: PulumiUpStepInput): string {
  return isAbsolute(input.dir) ? input.dir : resolve(input.cwd ?? process.cwd(), input.dir);
}

function readProject(dir: string): Record<string, unknown> | undefined {
  for (const name of ["Pulumi.yaml", "Pulumi.yml"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      return parseYAML(readFileSync(file, "utf-8"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requireInput(input: PulumiUpStepInput): void {
  if (typeof input?.dir !== "string" || input.dir === "") throw new Error('pulumi-up: the step needs "dir", the directory holding Pulumi.yaml');
  if (typeof input.stack !== "string" || input.stack === "" || input.stack.startsWith("-")) throw new Error('pulumi-up: the step needs "stack", the stack to apply');
}

/** `<member>/<stack>`: the member's name in the wave's set digest. */
export function pulumiUpMember(input: PulumiUpStepInput): string {
  const dir = stackDir(input);
  const named = input.member ?? (readProject(dir)?.name as string | undefined) ?? basename(dir);
  return `${named}/${input.stack}`;
}

/**
 * The stack's config with `config` written over it, as the text of a
 * `Pulumi.<stack>.yaml` (JSON, which YAML reads). A key with no `:` is the
 * project's own. A value left `undefined` or `null` is not written.
 */
export function pulumiScratchConfig(dir: string, stack: string, config: Record<string, unknown>): string {
  const project = readProject(dir)?.name;
  const file = join(dir, `Pulumi.${stack}.yaml`);
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      doc = parseYAML(readFileSync(file, "utf-8")) ?? {};
    } catch (err) {
      throw new Error(`pulumi-up: ${file} does not read as YAML, so its config cannot be copied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const merged: Record<string, unknown> = { ...((doc.config as Record<string, unknown> | undefined) ?? {}) };
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    const full = key.includes(":") || typeof project !== "string" ? key : `${project}:${key}`;
    merged[full] = value;
  }
  return `${JSON.stringify({ ...doc, config: merged }, null, 2)}\n`;
}

/** A plan file name with nothing a path could read into. */
const fileSafe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_");

/** What one streamed preview gave. */
interface StackPreview {
  part: ChangeSetPart;
  preview: { steps: PulumiStep[] };
  shape: PlanShape;
  policy: GatePolicyFindings;
  prior: unknown;
}

interface Resolved {
  dir: string;
  member: string;
  engine: PulumiMemberEngine;
  engineSource: PulumiMemberEngineSource;
  engineBecause: string;
  grain: PulumiLockGrain;
}

function resolveStep(input: PulumiUpStepInput, opts: PulumiUpOptions): Resolved {
  requireInput(input);
  const dir = stackDir(input);
  const member = pulumiUpMember(input);
  const picked = pulumiMemberEngine(dir, input.engine, opts.env ? { env: opts.env } : {});
  const grain = input.lockGrain ?? pulumiDefaultLockGrain(picked.engine);
  if (grain === "resource" && picked.engine === "pulumi") throw new PulumiResourceGrainRefusedError(member);
  return { dir, member, engine: picked.engine, engineSource: picked.source, engineBecause: picked.because, grain };
}

/** The scratch directory, the config copy in it and plunge's plan file path. */
function scratchFor(r: Resolved, input: PulumiUpStepInput, opts: PulumiUpOptions): { scratch: string; configFile?: string; planFile?: string } {
  const scratch = mkdtempSync(join(opts.tmp ?? tmpdir(), "chant-pulumi-up-"));
  let configFile: string | undefined;
  if (input.config && Object.keys(input.config).length > 0) {
    configFile = join(scratch, `Pulumi.${input.stack}.yaml`);
    writeFileSync(configFile, pulumiScratchConfig(r.dir, input.stack, input.config), { mode: 0o600 });
  }
  const planFile = r.engine === "plunge" ? join(scratch, `${fileSafe(r.member)}.plan.json`) : undefined;
  return { scratch, ...(configFile ? { configFile } : {}), ...(planFile ? { planFile } : {}) };
}

function dropScratch(scratch: string | undefined): void {
  if (!scratch) return;
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // A scratch dir that stays behind holds nothing a later run reads.
  }
}

/** The streamed preview, as part, shape and CrossGuard findings. Throws for a failed preview or a denial. */
async function previewStack(
  ctx: DeployContext,
  r: Resolved,
  input: PulumiUpStepInput,
  opts: PulumiUpOptions,
  files: { configFile?: string; planFile?: string },
): Promise<StackPreview> {
  const targets = ctx.targets && ctx.targets.length > 0 ? ctx.targets : undefined;
  const args = pulumiUpPreviewArgs({
    stack: input.stack,
    ...(files.planFile ? { savePlan: files.planFile } : {}),
    ...(files.configFile ? { configFile: files.configFile } : {}),
    ...(targets ? { targets } : {}),
    ...(input.policyPacks?.length ? { policyPacks: input.policyPacks } : {}),
  });
  let stdout: string;
  try {
    ({ stdout } =
      r.engine === "plunge"
        ? await runAllowedPlunge(opts.plunge ?? defaultPlungeRunner, args, r.dir, STREAMING)
        : await runAllowedPulumi(opts.run ?? defaultPulumiRunner, args, r.dir, STREAMING));
  } catch (err) {
    const f = pulumiRunFailure(err);
    if (f.missingBinary) throw new Error(`pulumi-up: "${r.member}": the ${r.engine} binary was not found on PATH; install ${r.engine} to plan this stack`);
    const stream = f.stdout ?? "";
    const policy = pulumiPolicyFindings(pulumiPolicyEvents(stream));
    if (policy.denials.length > 0 || pulumiExitOf(f.exitCode) === CHANT_EXIT.denied) throw new PulumiPolicyDeniedError(r.member, policy, pulumiStreamError(stream));
    const why = pulumiStreamError(stream) ?? (f.stderr?.trim() || f.message);
    throw new Error(`pulumi-up: "${r.member}": ${r.engine} preview failed: ${why}`);
  }
  const preview = pulumiStreamPreview(stdout);
  const policy = pulumiPolicyFindings(pulumiPolicyEvents(stdout));
  // A mandatory violation that left the exit at 0 still denies: the gate reads the events, never the code alone.
  if (policy.denials.length > 0) throw new PulumiPolicyDeniedError(r.member, policy);
  const prior = readMemberExport(r.dir);
  const part = pulumiPreviewPart({
    member: r.member,
    preview,
    stack: input.stack,
    ...(prior !== undefined ? { prior } : {}),
    ...(targets ? { targeted: true } : {}),
    ...(r.grain === "resource" ? { digest: { changedOnly: true } } : {}),
  });
  const shape = pulumiPlanShape(part, r.member);
  return { part, preview, shape, policy, prior };
}

/** The member of a stack whose `config` reads outputs not known yet: a hole naming them, no plan. */
function waitingStack(ctx: DeployContext, r: Resolved, input: PulumiUpStepInput, unresolved: string[]): CapabilityPlan {
  const config = Object.fromEntries(Object.entries(input.config ?? {}).map(([k, v]) => [k, v === undefined ? null : v]));
  const planDigest = computePlanDigest("pulumi-up-unresolved", { env: ctx.env, member: r.member, stack: input.stack, config, unresolved });
  const changeSet: ChangeSetPart = {
    member: {
      member: r.member,
      lexicon: "pulumi",
      planner: "pulumi",
      scope: input.stack,
      status: "planned",
      planDigest,
      holes: [
        {
          address: r.member,
          type: "pulumi:pulumi:Stack",
          reason: `the stack's config reads ${unresolved.join(", ")}, known only once ${unresolved.length === 1 ? "that applies" : "those apply"}; it is planned again then`,
        },
      ],
    },
    entries: [],
  };
  return { member: r.member, planDigest, changeSet, ...(ctx.targets?.length ? { targets: ctx.targets } : {}) };
}

function isArtifact(value: unknown): value is PulumiUpArtifact {
  const v = value as Partial<PulumiUpArtifact> | undefined;
  return v?.kind === "pulumi-up" && typeof v.planDigest === "string" && typeof v.shape === "object" && v.shape !== null;
}

async function planStack(ctx: DeployContext, input: PulumiUpStepInput, opts: PulumiUpOptions): Promise<CapabilityPlan> {
  const r = resolveStep(input, opts);
  const unresolved = [...(ctx.unresolvedInputs ?? [])].sort();
  if (unresolved.length > 0) return waitingStack(ctx, r, input, unresolved);
  const files = scratchFor(r, input, opts);
  let read: StackPreview;
  try {
    read = await previewStack(ctx, r, input, opts, files);
  } catch (err) {
    dropScratch(files.scratch);
    throw err;
  }
  const planDigest = read.part.member.planDigest!;
  const planned = pulumiMemberPlannedOutputs(r.member, { part: read.part, preview: read.preview, ...(read.prior !== undefined ? { exported: read.prior } : {}) });
  const artifact: PulumiUpArtifact = {
    kind: "pulumi-up",
    member: r.member,
    stack: input.stack,
    engine: r.engine,
    engineSource: r.engineSource,
    engineBecause: r.engineBecause,
    planDigest,
    shape: read.shape,
    scratch: files.scratch,
    ...(files.planFile ? { planFile: files.planFile } : {}),
    ...(files.configFile ? { configFile: files.configFile } : {}),
    policy: read.policy,
  };
  return {
    member: r.member,
    planDigest,
    artifact,
    changeSet: read.part,
    outputs: { known: planned.known, unknown: planned.unknown },
    shape: read.shape,
    ...(ctx.targets?.length ? { targets: ctx.targets } : {}),
  };
}

/** An `up` that exited non-zero, read through the exit-code table (#4553). */
function upFailure(r: Resolved, err: unknown, policy: GatePolicyFindings): Error {
  const f = pulumiRunFailure(err);
  if (f.missingBinary) return new Error(`pulumi-up: "${r.member}": the ${r.engine} binary was not found on PATH; nothing was applied`);
  const stream = f.stdout ?? "";
  const why = pulumiStreamError(stream) ?? (f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n");
  const outcome = pulumiExitOf(f.exitCode);
  if (outcome === CHANT_EXIT.moved) {
    return new PulumiPlanMovedError(r.member, `"${r.member}": refusing to apply. plunge refused the saved plan, since a record it planned against moved or the plan has no stamp: ${why}. Plan it again.`);
  }
  const events = pulumiPolicyFindings(pulumiPolicyEvents(stream));
  if (outcome === CHANT_EXIT.denied || events.denials.length > 0) {
    return new PulumiPolicyDeniedError(r.member, events.denials.length > 0 ? events : policy, why);
  }
  const landed = pulumiLandedUrns(stream);
  const failed = pulumiFailedUrns(stream);
  const detail = [
    ...(failed.length > 0 ? [`failed: ${failed.join(", ")}`] : []),
    ...(landed.length > 0 ? [`landed before it stopped: ${landed.join(", ")}`] : ["nothing landed"]),
  ].join("; ");
  return new Error(`pulumi-up: "${r.member}": ${r.engine} up failed (exit ${f.exitCode ?? "unknown"}): ${why}. ${detail}`);
}

async function runStack(ctx: DeployContext, input: PulumiUpStepInput, opts: PulumiUpOptions): Promise<PulumiUpStepOutput> {
  const r = resolveStep(input, opts);
  const handed = ctx.plans?.[r.member];
  const fromWave = isArtifact(handed);
  const targets = ctx.targets && ctx.targets.length > 0 ? ctx.targets : undefined;

  // Ruling D: no approved plan handed in, so plan here and apply that.
  let approved: PulumiUpArtifact;
  if (fromWave) {
    approved = handed;
  } else {
    const planned = await planStack(ctx, input, opts);
    if (!isArtifact(planned.artifact)) {
      throw new Error(`pulumi-up: "${r.member}": the stack's config reads outputs not known yet (${(ctx.unresolvedInputs ?? []).join(", ")}), so it cannot apply`);
    }
    approved = planned.artifact;
  }

  // The config copy: the plan's when it is still there, else written again (its text is the same).
  const own = existsSync(approved.scratch) ? undefined : scratchFor(r, input, opts);
  const configFile = approved.configFile && existsSync(approved.configFile) ? approved.configFile : own?.configFile;
  const tail = {
    ...(configFile ? { configFile } : {}),
    ...(targets ? { targets } : {}),
    ...(input.policyPacks?.length ? { policyPacks: input.policyPacks } : {}),
  };

  try {
    let stdout: string;
    if (r.engine === "plunge") {
      if (!approved.planFile || !existsSync(approved.planFile)) {
        throw new Error(`pulumi-up: "${r.member}": the saved plan ${approved.planFile ?? "(none)"} is not on this machine; plan the stack in the apply job, then apply`);
      }
      try {
        ({ stdout } = await runApplyPlunge(opts.plunge ?? defaultPlungeRunner, plungeUpArgs({ plan: approved.planFile, stack: input.stack, ...tail }), r.dir));
      } catch (err) {
        throw upFailure(r, err, approved.policy);
      }
    } else {
      if (fromWave) {
        // Preview again, and hold it to the approved shape before anything changes.
        const fresh = await previewStack(ctx, r, input, opts, { ...(configFile ? { configFile } : {}) });
        const differences = pulumiShapeDifferences(approved.shape, fresh.shape, fresh.preview.steps);
        if (differences.length > 0) throw new PlanShapeMovedError(r.member, differences);
      }
      try {
        ({ stdout } = await runApplyPulumi(opts.run ?? defaultPulumiRunner, pulumiUpArgs({ stack: input.stack, ...tail }), r.dir));
      } catch (err) {
        throw upFailure(r, err, approved.policy);
      }
      // Ruling A: the steps the update ran, held to the approved shape.
      const steps = pulumiAppliedSteps(stdout);
      const ran = pulumiPreviewPart({ member: r.member, preview: { steps }, stack: input.stack });
      const differences = pulumiShapeDifferences(approved.shape, pulumiPlanShape(ran, r.member), steps);
      if (differences.length > 0) throw new PulumiAppliedShapeError(r.member, differences, pulumiStreamSummary(stdout));
    }
    const outputs = await pulumiMemberStackOutputs({
      dir: r.dir,
      stack: input.stack,
      engine: r.engine,
      ...(opts.run ? { run: opts.run } : {}),
      ...(opts.plunge ? { plunge: opts.plunge } : {}),
    });
    const summary = pulumiStreamSummary(stdout);
    const hasPolicy = approved.policy.warnings.length > 0 || approved.policy.denials.length > 0;
    return {
      member: r.member,
      stack: input.stack,
      engine: r.engine,
      planDigest: approved.planDigest,
      fromWavePlan: fromWave,
      outputs,
      ...(summary ? { summary } : {}),
      ...(hasPolicy ? { policy: approved.policy } : {}),
    };
  } finally {
    dropScratch(approved.scratch);
    dropScratch(own?.scratch);
  }
}

/** `releaseInputs` (#4542): the stack's directory, or unbound when its state is a file relative to it. */
export function pulumiReleaseInputs(input: PulumiUpStepInput, ctx: ReleaseInputsContext): ReleaseInputs | ReleaseInputsUnbound | null {
  if (typeof input?.dir !== "string" || input.dir === "" || typeof input.stack !== "string") return null;
  const base = resolve(ctx.memberDir, input.cwd ?? ".");
  const dir = isAbsolute(input.dir) ? input.dir : resolve(base, input.dir);
  const project = readProject(dir);
  if (!project) return null;
  const toPosix = (p: string): string => p.split("\\").join("/") || ".";
  const fromMember = (abs: string): string => toPosix(relative(ctx.memberDir, abs));
  const backend = (project.backend as { url?: unknown } | undefined)?.url;
  if (typeof backend === "string") {
    const m = /^(?:plunge\+)?file:\/\/(.*)$/.exec(backend);
    if (m && !m[1].startsWith("/") && !m[1].startsWith("~")) {
      return {
        unbound: `stack "${input.stack}" keeps its state at ${backend}, a path relative to ${fromMember(dir)}, so a preview of a recorded copy would read no state; roll it back with chant lifecycle rollback --to <ref>`,
      };
    }
  }
  const paths = [fromMember(dir)];
  const main = typeof project.main === "string" ? resolve(dir, project.main) : undefined;
  if (main && relative(dir, main).startsWith("..")) paths.push(fromMember(main));
  return { field: "dir", dir: fromMember(dir), paths: [...new Set(paths)].sort() };
}

/** The `pulumi-up` capability, with injectable runners for tests. */
export function createPulumiUpCapability(opts: PulumiUpOptions = {}): Capability<PulumiUpStepInput, PulumiUpStepOutput> {
  return {
    kind: "pulumi-up",
    // A stack's update has no undo short of applying the previous program, which is a change of its own.
    rollbackPolicy: "needs-opt-out",
    // Each target passes as `--target <urn>` to the preview and to `up`.
    targets: "accept",
    plan: (ctx, input) => planStack(ctx, input, opts),
    run: (ctx, input) => runStack(ctx, input, opts),
    // The outputs standing now, for a dependent planned before this stack applies.
    async outputs(_ctx, input) {
      const r = resolveStep(input, opts);
      return pulumiMemberStackOutputs({
        dir: r.dir,
        stack: input.stack,
        engine: r.engine,
        ...(opts.run ? { run: opts.run } : {}),
        ...(opts.plunge ? { plunge: opts.plunge } : {}),
      });
    },
    releaseInputs: (input, ctx) => pulumiReleaseInputs(input, ctx),
  };
}

export const pulumiUpCapability = createPulumiUpCapability();
