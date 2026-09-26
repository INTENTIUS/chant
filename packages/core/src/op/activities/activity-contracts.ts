/**
 * Activity contracts for core's own `op/activities` (chant #1288
 * Stage 1). Each contract's `args` schema mirrors the corresponding
 * `*Args` interface in `./activities/*.ts` — kept alongside the
 * implementation, the way the issue asked for, and validated by
 * `chant build` via `tmp012` (the OPS012 activity-contract rule).
 *
 * Author `args` with `z.strictObject(...)`, never `z.object(...)`: the
 * default form silently drops a key it doesn't recognize instead of
 * rejecting it, which reproduces the exact bug this issue is about
 * (`helmInstall("api", "./chart", { nameSpace: "prod" })` — the misspelled
 * key vanishes rather than failing the build).
 *
 * Deliberately partial. Only activities with args simple enough for a zod
 * mirror to earn its keep are covered here — `kubectlApply`/`helmInstall`/
 * the cloud appliers carry a dozen-plus fields each with real cross-field
 * logic (see `KubectlApplyArgs`, `HelmInstallArgs`), and forcing those
 * through a duplicate schema is exactly the maintenance burden Stage 2
 * (regenerating the step builders as fully typed wrappers) is meant to
 * avoid by deriving types instead of restating them. A step calling an
 * activity with no registered contract here is skipped by `tmp012`, not
 * flagged — see `activityContract`'s doc in `../activity-contract` for why
 * that's the intended, non-breaking default.
 */

import { z } from "zod";
import { activityContract } from "../activity-contract";

export const lifecycleSnapshotContract = activityContract(
  "lifecycleSnapshot",
  z.strictObject({ env: z.string() }),
);

export const lifecycleDiffContract = activityContract(
  "lifecycleDiff",
  z.strictObject({ env: z.string(), live: z.boolean().optional() }),
  z.object({ output: z.string(), exitCode: z.number(), drifted: z.boolean() }),
);

/**
 * The escape hatch (#2413). `returns` is what `shellCmd` captured and used to
 * throw away: the trimmed stdout, the trimmed stderr, and the exit code —
 * which only ever differs from `0` when the step named that code in `okExit`,
 * since anything else still rejects.
 *
 * Running a command chant does not model in order to discard what it produced
 * is the odd case, not the normal one, so the value a later step reads through
 * `sh.out.stdout` is the point of the step rather than an extra.
 */
export const shellCmdContract = activityContract(
  "shellCmd",
  z.strictObject({
    cmd: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    okExit: z.array(z.number()).optional(),
    gatedExit: z.number().optional(),
    gate: z.strictObject({ op: z.string(), gate: z.string() }).optional(),
  }),
  z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number() }),
);

export const httpCheckContract = activityContract(
  "httpCheck",
  z.strictObject({
    url: z.string(),
    method: z.string().optional(),
    status: z.number().optional(),
    contains: z.string().optional(),
    retries: z.number().optional(),
    intervalMs: z.number().optional(),
  }),
  z.object({ status: z.number() }),
  // The check's effect is entity-scoped (#2022): `url` names the service the
  // step probes, so op.json resolves it into the step's `entities` — the join
  // a renderer draws to the estate node it targets. The scope-ish args
  // (retries, interval) stay mechanics.
  { entities: ["url"] },
);

export const chantTeardownContract = activityContract(
  "chantTeardown",
  z.strictObject({ path: z.string() }),
);

/**
 * The prediction (#2358). `args` mirrors `PredictBehaviourArgs` field for
 * field; the return is the contract's `BehaviourResult`, a report or a
 * refusal, so `returns` is the envelope both arms share and a step's
 * `outcomeAttribute.from` may name `behaviour` or `refusal`.
 */
export const predictBehaviourContract = activityContract(
  "predictBehaviour",
  z.strictObject({
    environment: z.string(),
    traffic: z.string(),
    stack: z.string().optional(),
    region: z.string().optional(),
    owned: z.boolean().optional(),
  }),
  z.object({ behaviour: z.literal("v1"), refusal: z.unknown().optional() }),
);

/**
 * The pull-request finding (#2358). Same inputs as the prediction plus the
 * Op's name (the marker's key, #2319), the mode, and an optional explicit
 * base branch. `returns` names what a step reads as an outcome — the posted
 * URL, and whether either side refused.
 */
export const behaviourFindingContract = activityContract(
  "behaviourFinding",
  z.strictObject({
    environment: z.string(),
    traffic: z.string(),
    op: z.string(),
    mode: z.enum(["comment", "report"]).optional(),
    base: z.string().optional(),
    title: z.string().optional(),
    stack: z.string().optional(),
    region: z.string().optional(),
    owned: z.boolean().optional(),
  }),
  z.object({
    mode: z.enum(["comment", "report"]),
    base: z.string(),
    head: z.string(),
    refused: z.boolean(),
    summary: z.string(),
    commentUrl: z.string().optional(),
    pullRequest: z.string().optional(),
    mergeRequest: z.string().optional(),
  }),
);

/**
 * The propose-only template upgrade (#2550, ws-032). `args` mirrors
 * `ProposeWorkspaceUpgradeArgs` without its test hooks. `returns` names what
 * a step reads: whether anything changed, whether it was proposed, the patch
 * digest the command's gate would bind, and the branch and pull request.
 */
export const proposeWorkspaceUpgradeContract = activityContract(
  "proposeWorkspaceUpgrade",
  z.strictObject({
    scope: z.string().optional(),
    to: z.string().optional(),
    mode: z.enum(["report", "branch", "pull-request"]).optional(),
    branch: z.string().optional(),
    base: z.string().optional(),
    remote: z.string().optional(),
    allowCode: z.boolean().optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    scope: z.string(),
    mode: z.enum(["report", "branch", "pull-request"]),
    changed: z.boolean(),
    proposed: z.boolean(),
    checksOk: z.boolean(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    digest: z.string(),
    manualSteps: z.number(),
    governance: z.boolean(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    pushed: z.boolean().optional(),
    prUrl: z.string().optional(),
    summary: z.string(),
  }),
);

/**
 * The forward coverage check over an Op's own diff (#2773). `args` mirrors
 * `ChangeCoverageArgs`. `returns` names what a step reads: whether the check
 * passed, the range and work item checked, and each finding with the
 * `triage` a work item seeded from it takes as its `source`.
 */
export const changeCoverageContract = activityContract(
  "changeCoverage",
  z.strictObject({
    cwd: z.string().optional(),
    range: z.string().optional(),
    work: z.string().optional(),
    severity: z.enum(["off", "warn", "fail"]).optional(),
  }),
  z.object({
    ok: z.boolean(),
    range: z.object({ spec: z.string(), base: z.string(), head: z.string() }),
    work: z.string().nullable(),
    severity: z.enum(["off", "warn", "fail"]),
    findings: z.array(
      z.object({
        code: z.enum(["change-uncovered", "change-out-of-scope"]),
        path: z.string(),
        message: z.string(),
        severity: z.enum(["warn", "fail"]),
        records: z.array(z.string()),
        triage: z.object({ finding: z.enum(["change-uncovered", "change-out-of-scope"]), region: z.string() }),
      }),
    ),
    summary: z.object({
      paths: z.number(),
      covered: z.number(),
      uncovered: z.number(),
      outOfScope: z.number(),
      ignored: z.number(),
      records: z.number(),
    }),
  }),
);

/**
 * Evidence for an acceptance criterion, under the run's work lease (#2772).
 * `lease` is the run's lease, a reference the builder fills in, so it is not
 * checked here. `returns` names what a step reads: the item, the record's
 * path, the entry appended and the criteria counted with it.
 */
export const workEvidenceContract = activityContract(
  "workEvidence",
  z.strictObject({
    lease: z.unknown(),
    criterion: z.string(),
    result: z.enum(["pass", "fail"]),
    title: z.string(),
    url: z.string().optional(),
    path: z.string().optional(),
    kind: z.string().optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    item: z.string(),
    path: z.string(),
    evidence: z.record(z.string(), z.unknown()),
    acceptance: z.object({ met: z.number(), total: z.number(), criteria: z.array(z.object({ id: z.string(), verification: z.string(), met: z.boolean() })) }),
  }),
);
