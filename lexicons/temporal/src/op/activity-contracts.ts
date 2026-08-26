/**
 * Activity contracts for this lexicon's own `op/activities` (chant #1288
 * Stage 1). Each contract's `args` schema mirrors the corresponding
 * `*Args` interface in `./activities/*.ts` — kept alongside the
 * implementation, the way the issue asked for, and validated by
 * `chant build` via `tmp012` (`../lint/post-synth/tmp012-activity-contract.ts`).
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
 * flagged — see `activityContract`'s doc in `@intentius/chant/op` for why
 * that's the intended, non-breaking default.
 */

import { z } from "zod";
import { activityContract } from "@intentius/chant/op";

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
);

export const chantTeardownContract = activityContract(
  "chantTeardown",
  z.strictObject({ path: z.string() }),
);

/**
 * Test-only contract for op-ir.test.ts: a schema with a transform,
 * which z.toJSONSchema cannot handle. Used to verify buildOpIR
 * gracefully skips JSON-Schema-incompatible contracts.
 */
export const testTransformContract = activityContract(
  "testTransformActivity",
  z.strictObject({ value: z.string().transform((s) => s.length) }),
);
