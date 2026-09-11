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

export const shellCmdContract = activityContract(
  "shellCmd",
  z.strictObject({ cmd: z.string(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }),
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
