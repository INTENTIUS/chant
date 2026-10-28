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
 *   the resource lock grain (the step's `lockGrain`, else `ci.lockGrain`
 *   through `DeployContext.lockGrain`, else `resource` on plunge and
 *   `target` on stock Pulumi, #4552) the digest leaves `same` and `read`
 *   steps out (ruling B);
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
 * --show-secrets=false`, secrets as `[secret]`. Then `stack export --stack
 * <s>` runs, its secrets are stripped, and it goes to the index store as
 * the member's snapshot (#4546, `./stack-export-snapshot.ts`), at
 * `<env>/<stack>__pulumi-export` on `refs/chant/snapshots` by default. The
 * graph and the member's reads take it from there, so the member needs no
 * checked-in `stack-export.json`. A failed export or write leaves the apply
 * standing and says why in `exportSnapshot`.
 *
 * ## config
 *
 * `config` (a dependent's `stackOutput()` wiring) is written into a scratch
 * copy of `Pulumi.<stack>.yaml` and passed with `--config-file`; `--config`
 * is never used, since it saves into the working tree's file. A key with no
 * `:` is the project's own (`<project>:<key>`).
 *
 * ## StackReference (#4547)
 *
 * `declaredReads` reads each step's export for its `StackReference`s
 * (`./stack-references.ts`) and reports each as a read of the other
 * `pulumi-up` step that applies the referenced stack, so core orders the
 * reader after it, holds the reader when it fails, and leaves the reader a
 * hole while the upstream's plan cannot say an output it reads. A reference
 * to a stack no step applies adds no edge and is named on the plan's
 * artifact under `stackReferences.outside`.
 *
 * ## releases (#4542)
 *
 * `releaseInputs` answers the stack's directory, so a release cut records it
 * and a promote or rollback under the release previews and applies the
 * recorded copy, under the release gate with that copy's plan. A stack whose
 * backend is a file path relative to its directory is unbound: a copy
 * elsewhere would read no state.
 *
 * The cut records tracked files, so a Node program's copy has no
 * `node_modules`. Before the copy's first preview, `plan` and `run` call
 * `prepareReleaseCopy` (`./release-copy.ts`), which runs `pulumi install`
 * (`plunge install`) in the copy when its runtime needs one, and refuses a
 * Node copy with no lockfile by name, since an install would take today's
 * versions rather than the release's.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type {
  Capability,
  CapabilityPlan,
  DeclaredRead,
  DeclaredReadMember,
  DeclaredReadsContext,
  DeployContext,
  ReleaseInputs,
  ReleaseInputsContext,
  ReleaseInputsUnbound,
} from "@intentius/chant/components/capability";
import { PlanShapeMovedError, type PlanShape } from "@intentius/chant/components/covered-round";
import type { GatePolicyFindings } from "@intentius/chant/gate-policy";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import type { SnapshotStore } from "@intentius/chant/lifecycle/snapshot-store";
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
  pulumiStreamTimings,
  type PulumiApplySummary,
} from "./engine-events";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { pulumiExitOf } from "./exit-codes";
import { pulumiMemberEngine, type PulumiMemberEngine, type PulumiMemberEngineSource } from "./member-engine";
import { ciEngineDir, ciRelease, CI_ENGINE_ROOT } from "./ci-setup";
import { pulumiMemberPlannedOutputs } from "./member-outputs";
import { pulumiPlanShape, pulumiShapeDifferences } from "./plan-shape";
import { pulumiLockRows } from "./lock-rows";
import { pulumiTraceFacts } from "./trace-facts";
import {
  defaultPlungeRunner,
  defaultPulumiRunner,
  engineRunnerAt,
  plungeUpArgs,
  pulumiMemberStackOutputs,
  pulumiRunFailure,
  pulumiUpArgs,
  pulumiUpPreviewArgs,
  memberExportOf,
  runAllowedPlunge,
  runAllowedPulumi,
  runApplyPlunge,
  runApplyPulumi,
  type PulumiPolicyPack,
  type PulumiRunner,
} from "./run";
import type { PulumiStep } from "./change-set";
import { writePulumiExportSnapshot, type PulumiExportWrite } from "./stack-export-snapshot";
import { pointerSegment, pulumiStackReferences, stackReferenceOwner } from "./stack-references";
import { prepareReleaseCopy } from "./release-copy";

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
  /**
   * The engine release this stack is pinned to (#4592): the step runs
   * `<engineRoot>/<engine>-<engineVersion>/<engine>`, the path the pulumi
   * lexicon's install lines write (`pulumiInstallLine`, `plungeInstallLine`,
   * `ciEngineDir`), instead of the binary on PATH. A semver such as
   * `3.272.0`, or for plunge its own release such as `0.1.0`. Absent: the
   * binary on PATH, as before.
   */
  engineVersion?: string;
  /** Where the versioned installs live, as the install lines' `root` (#4592). Default `/opt/chant`. Needs `engineVersion`. */
  engineRoot?: string;
  /** Where a relative `dir` resolves from. Default: the process's working directory. */
  cwd?: string;
  /** The member's lock grain (#4552), over `ci.lockGrain`. Default: `ci.lockGrain`, else `resource` on plunge, `target` on stock Pulumi. */
  lockGrain?: PulumiLockGrain;
  /** CrossGuard packs for the preview and `up` (ruling 7). */
  policyPacks?: PulumiPolicyPack[];
  /**
   * The outputs of other stacks this stack's program reads through
   * `StackReference` (#4547), by the reference's name, then output. Core
   * writes them from `declaredReads` as `stackOutput()` references, so the
   * stack plans after the ones it reads and waits while their plans cannot
   * say a value. Never passed to the engine: the program reads them itself.
   */
  stackReferences?: Record<string, Record<string, unknown>>;
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
  /** The stack export written to the index store after `up` (#4546), or why it was not. */
  exportSnapshot?: PulumiExportWrite;
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
  /**
   * The stack's `StackReference`s (#4547): `read`, wired to another step of
   * the project, and `outside`, which add no edge, each with why.
   */
  stackReferences?: { read: string[]; outside: { name: string; why: string }[] };
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

/**
 * An `up` that failed (#4553's failed outcome). It carries the stream's
 * summary, plunge's per-resource timings included (#4579), so the run record
 * and the trace (`./trace-facts.ts` reads `member` and `summary` off the
 * error) keep what ran before it stopped.
 */
export class PulumiUpFailedError extends Error {
  constructor(
    public readonly member: string,
    message: string,
    public readonly summary?: PulumiApplySummary,
  ) {
    super(message);
    this.name = "PulumiUpFailedError";
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
  /** The runner for a pinned binary (#4592), by its path. Default: {@link engineRunnerAt}. */
  runAt?: (bin: string) => PulumiRunner;
  /** The job environment the engine is picked from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Where scratch directories go. Default: the OS temp dir. */
  tmp?: string;
  /** The index store the stack export goes to after `up` and the prior export is read from (#4546). Default: the project's; `null` writes nothing and reads the checked-in file only. */
  snapshots?: SnapshotStore | null;
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
  /** The pinned binary's absolute path (#4592), when the step names `engineVersion`. */
  engineBin?: string;
  engineSource: PulumiMemberEngineSource;
  engineBecause: string;
  grain: PulumiLockGrain;
}

function resolveStep(input: PulumiUpStepInput, opts: PulumiUpOptions, declared?: PulumiLockGrain): Resolved {
  requireInput(input);
  const dir = stackDir(input);
  const member = pulumiUpMember(input);
  const picked = pulumiMemberEngine(dir, input.engine, opts.env ? { env: opts.env } : {});
  // #4552: the step's own grain, else ci.lockGrain as the caller read it at base, else the engine's default.
  const grain = input.lockGrain ?? declared ?? pulumiDefaultLockGrain(picked.engine);
  if (grain === "resource" && picked.engine === "pulumi") throw new PulumiResourceGrainRefusedError(member);
  const engineBin = pulumiUpEngineBin(input, picked.engine);
  return { dir, member, engine: picked.engine, ...(engineBin ? { engineBin } : {}), engineSource: picked.source, engineBecause: picked.because, grain };
}

/**
 * The binary a step pinned with `engineVersion` runs (#4592): the versioned
 * path the install lines write. Undefined without `engineVersion`, so the
 * binary on PATH runs. A version or root a shell or path would read as
 * more is refused, as the install lines refuse it.
 */
export function pulumiUpEngineBin(input: Pick<PulumiUpStepInput, "engineVersion" | "engineRoot">, engine: PulumiMemberEngine): string | undefined {
  if (input.engineVersion === undefined) {
    if (input.engineRoot !== undefined) throw new Error('pulumi-up: "engineRoot" needs "engineVersion", the release installed under it');
    return undefined;
  }
  try {
    ciRelease(engine, input.engineVersion);
    return `${ciEngineDir(engine, input.engineVersion, input.engineRoot ?? CI_ENGINE_ROOT)}/${engine}`;
  } catch (err) {
    throw new Error(`pulumi-up: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The `run` and `plunge` options for the stack output and export reads: the pinned binary's for both when the step names one (#4592), else the caller's. */
function runnerOptions(r: Pick<Resolved, "engineBin">, opts: PulumiUpOptions): { run?: PulumiRunner; plunge?: PulumiRunner } {
  if (r.engineBin) {
    const { pulumi, plunge } = runnersFor(r, opts);
    return { run: pulumi, plunge };
  }
  return { ...(opts.run ? { run: opts.run } : {}), ...(opts.plunge ? { plunge: opts.plunge } : {}) };
}

/** The runners a resolved step uses: the pinned binary's when it names one, else the options' or the PATH default. */
function runnersFor(r: Pick<Resolved, "engineBin">, opts: PulumiUpOptions): { pulumi: PulumiRunner; plunge: PulumiRunner } {
  if (r.engineBin) {
    const pinned = opts.runAt ? opts.runAt(r.engineBin) : engineRunnerAt(r.engineBin);
    return { pulumi: pinned, plunge: pinned };
  }
  return { pulumi: opts.run ?? defaultPulumiRunner, plunge: opts.plunge ?? defaultPlungeRunner };
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
        ? await runAllowedPlunge(runnersFor(r, opts).plunge, args, r.dir, STREAMING)
        : await runAllowedPulumi(runnersFor(r, opts).pulumi, args, r.dir, STREAMING));
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
  const prior = await memberExportOf(r.dir, { stack: input.stack, ...(opts.snapshots !== undefined ? { store: opts.snapshots } : {}) });
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

/** The member of a stack whose `config` or `StackReference`s read outputs not known yet: a hole naming them, no plan. */
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
          reason: `the stack reads ${unresolved.join(", ")}, known only once ${unresolved.length === 1 ? "that applies" : "those apply"}; it is planned again then`,
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

/** A release's copy of the program, made runnable before its first engine run (#4542). */
async function readyCopy(r: Resolved, opts: PulumiUpOptions): Promise<void> {
  const runners = runnersFor(r, opts);
  await prepareReleaseCopy({ dir: r.dir, member: r.member, engine: r.engine, run: r.engine === "plunge" ? runners.plunge : runners.pulumi });
}

async function planStack(ctx: DeployContext, input: PulumiUpStepInput, opts: PulumiUpOptions): Promise<CapabilityPlan> {
  const r = resolveStep(input, opts, ctx.lockGrain);
  const unresolved = [...(ctx.unresolvedInputs ?? [])].sort();
  if (unresolved.length > 0) return waitingStack(ctx, r, input, unresolved);
  await readyCopy(r, opts);
  const files = scratchFor(r, input, opts);
  let read: StackPreview;
  try {
    read = await previewStack(ctx, r, input, opts, files);
  } catch (err) {
    dropScratch(files.scratch);
    throw err;
  }
  const planDigest = read.part.member.planDigest!;
  const references = stackReferencesOf(read.prior, input);
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
    ...(references ? { stackReferences: references } : {}),
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

/** The export's `StackReference`s, split into the ones core wired into `stackReferences` and the rest; undefined when it holds none. */
function stackReferencesOf(exported: unknown, input: PulumiUpStepInput): PulumiUpArtifact["stackReferences"] | undefined {
  const refs = pulumiStackReferences(exported);
  if (refs.length === 0) return undefined;
  const wired = new Set(Object.keys(input.stackReferences ?? {}));
  const read = refs.filter((r) => wired.has(r.name)).map((r) => r.name);
  const outside = refs
    .filter((r) => !wired.has(r.name))
    .map((r) => ({
      name: r.name,
      why:
        r.outputs.length === 0 && r.secretOutputs.length > 0
          ? "every output the export recorded for it is secret, and chant reads outputs blind"
          : r.outputs.length === 0
            ? "the export recorded no output for it"
            : "no other pulumi-up step in this project applies that stack",
    }));
  return { read: [...new Set(read)].sort(), outside };
}

/**
 * `declaredReads` (#4547): each step's `StackReference`s, read from its
 * export (the index store's, else the checked-in one), as reads of the one
 * other `pulumi-up` step whose project and stack the reference names, one
 * per output the export recorded that is not secret, placed at
 * `/stackReferences/<reference name>/<output>`.
 */
export async function pulumiDeclaredReads(
  ctx: DeclaredReadsContext,
  members: readonly DeclaredReadMember[],
  opts: { exportStore?: SnapshotStore | null } = {},
): Promise<DeclaredRead[]> {
  const steps = members
    .map((m) => {
      const step = m.step as unknown as PulumiUpStepInput;
      if (typeof step?.dir !== "string" || typeof step.stack !== "string") return undefined;
      const dir = isAbsolute(step.dir) ? step.dir : resolve(ctx.root, step.cwd ?? ".", step.dir);
      const project = readProject(dir)?.name;
      return { m, step, dir, project: typeof project === "string" ? project : basename(dir) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined);
  const owners = steps.map((s) => ({ component: s.m.component, project: s.project, stack: s.step.stack }));
  const out: DeclaredRead[] = [];
  for (const s of steps) {
    const exported = await memberExportOf(s.dir, { stack: s.step.stack, ...(opts.exportStore !== undefined ? { store: opts.exportStore } : {}) });
    for (const ref of pulumiStackReferences(exported)) {
      const found = stackReferenceOwner(ref, { component: s.m.component, project: s.project }, owners);
      if (!("owner" in found)) continue;
      for (const output of ref.outputs) {
        out.push({ reader: s.m.component, index: s.m.index, upstream: found.owner.component, output, at: `/stackReferences/${pointerSegment(ref.name)}/${pointerSegment(output)}` });
      }
    }
  }
  return out;
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
  return new PulumiUpFailedError(r.member, `pulumi-up: "${r.member}": ${r.engine} up failed (exit ${f.exitCode ?? "unknown"}): ${why}. ${detail}`, failedUpSummary(stream));
}

/**
 * What a failed `up`'s stream still says (#4579): its `summaryEvent`, or,
 * when the engine stopped before printing one, the per-resource timings
 * plunge put on the steps that ran (`resOutputsEvent`, `resOpFailedEvent`),
 * under `result: "failed"`. Undefined when the stream holds neither.
 */
export function failedUpSummary(stream: string): PulumiApplySummary | undefined {
  const summary = pulumiStreamSummary(stream);
  if (summary) return summary;
  const timings = pulumiStreamTimings(stream);
  return Object.keys(timings).length > 0 ? { resourceChanges: {}, result: "failed", timings } : undefined;
}

async function runStack(ctx: DeployContext, input: PulumiUpStepInput, opts: PulumiUpOptions): Promise<PulumiUpStepOutput> {
  const r = resolveStep(input, opts, ctx.lockGrain);
  const handed = ctx.plans?.[r.member];
  const fromWave = isArtifact(handed);
  const targets = ctx.targets && ctx.targets.length > 0 ? ctx.targets : undefined;
  await readyCopy(r, opts);

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
        ({ stdout } = await runApplyPlunge(runnersFor(r, opts).plunge, plungeUpArgs({ plan: approved.planFile, stack: input.stack, ...tail }), r.dir));
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
        ({ stdout } = await runApplyPulumi(runnersFor(r, opts).pulumi, pulumiUpArgs({ stack: input.stack, ...tail }), r.dir));
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
      ...runnerOptions(r, opts),
    });
    const summary = pulumiStreamSummary(stdout);
    const exportSnapshot = await writePulumiExportSnapshot({
      dir: r.dir,
      stack: input.stack,
      environment: ctx.env,
      engine: r.engine,
      ...runnerOptions(r, opts),
      ...(opts.snapshots !== undefined ? { store: opts.snapshots } : {}),
    });
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
      exportSnapshot,
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
        ...runnerOptions(r, opts),
      });
    },
    releaseInputs: (input, ctx) => pulumiReleaseInputs(input, ctx),
    // #4552: resource on plunge, the stack (target) on stock Pulumi.
    defaultLockGrain(input) {
      requireInput(input);
      return pulumiDefaultLockGrain(pulumiMemberEngine(stackDir(input), input.engine, opts.env ? { env: opts.env } : {}).engine);
    },
    // Stock Pulumi keeps the stack grain: its backend's stack lock already orders updates, and nothing in it is per resource.
    lockGrainRefusal(input, grain) {
      if (grain !== "resource") return undefined;
      requireInput(input);
      const engine = pulumiMemberEngine(stackDir(input), input.engine, opts.env ? { env: opts.env } : {}).engine;
      return engine === "pulumi" ? new PulumiResourceGrainRefusedError(pulumiUpMember(input)).message : undefined;
    },
    // URN rows, object rows, and the stack row when something may appear only at apply (./lock-rows.ts).
    lockRows(input, plan) {
      if (!plan.changeSet) return [];
      const project = readProject(stackDir(input))?.name;
      return pulumiLockRows(plan.changeSet, plan.member, { ...(typeof project === "string" ? { project } : {}), stack: input.stack });
    },
    // #4555: the stack, the engine and the summary's counts, for the step's span and run record.
    traceFacts: (input, outcome) => pulumiTraceFacts(input, outcome),
    declaredReads: (ctx, members) => pulumiDeclaredReads(ctx, members, opts.snapshots !== undefined ? { exportStore: opts.snapshots } : {}),
  };
}

export const pulumiUpCapability = createPulumiUpCapability();
