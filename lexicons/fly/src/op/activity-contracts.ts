/**
 * Activity contracts for this lexicon's `op/activities` (chant #2101, #2843).
 *
 * Resolved by convention at `@intentius/chant-lexicon-fly/op/activity-contracts`:
 * `loadActivityContracts` (`packages/core/src/op/activity-contract-registry.ts`)
 * merges what it finds here into the map core's OPS012 and OPS013 validate
 * every Op step against.
 *
 * Only the activities a step's output is referenced from are covered.
 * `spriteServicesObserve` is the observer of a `ConvergeOp({ observe })`
 * (#2778), whose Converge step reads the observer's whole output, so OPS013
 * needs its return schema; without one, every project declaring such a
 * ConvergeOp failed `chant build` and `chant lint`. `spriteServiceRestart` is
 * the step of the Op such a ConvergeOp's rule runs, and its result is what a
 * later step would read. `spriteApplyServices` is covered for its box form
 * (#2880): `box`, `only`, `start` and `restart`, and the per-service actions
 * its result names. The other Sprites activities have no contract yet,
 * which OPS012 skips rather than flags.
 *
 * Each `args` schema mirrors the `*Args` interface in
 * `./activities/sprite-service-converge.ts` or `./activities/sprite-config.ts`
 * and each `returns` schema the `*Result`. Authored with `z.strictObject(...)`, so a misspelled key fails
 * the build instead of vanishing.
 */

import { z } from "zod";
import { activityContract } from "@intentius/chant/op";

const declaredService = z.strictObject({
  name: z.string(),
  health: z.string().optional(),
  optional: z.boolean().optional(),
});

/** `Via`: the sprite for the Sprites API, or `sprite-env` inside the sprite. */
const via = {
  id: z.string().optional(),
  spriteEnv: z.string().optional(),
  endpoint: z.string().optional(),
  token: z.string().optional(),
};

export const spriteServicesObserveContract = activityContract(
  "spriteServicesObserve",
  z.strictObject({
    ...via,
    services: z.array(declaredService).optional(),
    servicesFile: z.string().optional(),
    box: z.boolean().optional(),
    probes: z.number().optional(),
    probeIntervalMs: z.number().optional(),
  }),
  z.object({
    resources: z.array(z.object({ name: z.string(), status: z.enum(["in-sync", "drifted", "unknown"]), detail: z.string() })),
    skipped: z.array(z.string()),
  }),
);

export const spriteServiceRestartContract = activityContract(
  "spriteServiceRestart",
  z.strictObject({
    ...via,
    name: z.string().optional(),
    health: z.string().optional(),
    services: z.array(declaredService).optional(),
    servicesFile: z.string().optional(),
    box: z.boolean().optional(),
    waitMs: z.number().optional(),
  }),
  z.object({ name: z.string(), healthy: z.boolean().nullable() }),
);

const serviceSpec = z.strictObject({
  name: z.string(),
  cmd: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  dir: z.string().optional(),
  needs: z.array(z.string()).optional(),
  http_port: z.number().optional(),
});

export const spriteApplyServicesContract = activityContract(
  "spriteApplyServices",
  z.strictObject({
    id: z.string().optional(),
    services: z.array(serviceSpec).optional(),
    box: z.boolean().optional(),
    only: z.array(z.string()).optional(),
    start: z.boolean().optional(),
    restart: z.boolean().optional(),
    spriteEnv: z.string().optional(),
    endpoint: z.string().optional(),
    token: z.string().optional(),
  }),
  z.object({
    applied: z.array(z.string()),
    started: z.array(z.string()),
    services: z.array(z.object({ name: z.string(), action: z.enum(["created", "replaced", "restarted", "started", "left"]) })).optional(),
  }),
);
