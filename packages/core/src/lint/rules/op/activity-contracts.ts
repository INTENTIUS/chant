/**
 * Core's own registered activity contracts, validated by OPS012
 * (`./ops012-activity-contract.ts`) and OPS013 (`./ops013-step-output-ref.ts`)
 * against every declared Op — chant #2122 (epic #2114 sub-issue 6).
 *
 * `lexicons/temporal/src/op/activity-contracts.ts` declares this exact
 * roster today (kept there, unchanged — `op-ir.ts` and `converge-op.ts` still
 * read it directly and neither moves in this issue). Epic #2114's "Base
 * activities live in core" decision (sub-issue 1, #2117) is what actually
 * relocates `lifecycle`/`http-check`/`shell` and the rest of the activity
 * roster into `packages/core/src/op/activities/`; until that lands, this file
 * is a deliberately small, hand-duplicated subset — just the three activities
 * OPS012/OPS013's ported tests exercise — so the two checks have a real
 * contract to validate against even before the full roster arrives. #2117
 * should fold this into whatever it moves rather than leave two copies.
 */

import { z } from "zod";
import { activityContract } from "../../../op";

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
  // Mirrors the temporal lexicon's own httpCheckContract (#2022): `url`
  // names the service the step probes.
  { entities: ["url"] },
);
