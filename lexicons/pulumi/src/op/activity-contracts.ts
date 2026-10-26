/**
 * Activity contracts for this lexicon's `op/activities` (#4494), resolved at
 * `@intentius/chant-lexicon-pulumi/op/activity-contracts` by
 * `loadActivityContracts` (`packages/core/src/op/activity-contract-registry.ts`)
 * for OPS012 and OPS013, the same convention the terraform lexicon follows.
 * Each `args` schema mirrors the `*Args` interface in `./activities/pulumi.ts`
 * and is strict, so a misspelled field fails the build; each `returns` schema
 * spells the fields an outcome or a later step may reference.
 */
import { z } from "zod";
import { activityContract } from "@intentius/chant/op";

const memberArgs = {
  member: z.string(),
  dir: z.string(),
  cwd: z.string().optional(),
  stack: z.string().optional(),
  engine: z.enum(["pulumi", "plunge"]).optional(),
};

/** The `member` arg names the workspace member the step reads, so op.json's IR can join the step to it. */
const memberEntity = { entities: ["member"] };

export const pulumiPreviewContract = activityContract(
  "pulumiPreview",
  z.strictObject(memberArgs),
  z.object({
    member: z.string(),
    engine: z.enum(["pulumi", "plunge"]),
    status: z.enum(["planned", "failed"]),
    error: z.string().optional(),
    planDigest: z.string().nullable(),
    changed: z.boolean(),
    creates: z.number(),
    updates: z.number(),
    replaces: z.number(),
    deletes: z.number(),
    mayAppear: z.number(),
  }),
  memberEntity,
);

export const pulumiDriftContract = activityContract(
  "pulumiDrift",
  z.strictObject({ ...memberArgs, urns: z.array(z.string()).optional() }),
  z.object({
    member: z.string(),
    counts: z.record(z.string(), z.number()),
    drifted: z.number(),
    notObserved: z.number(),
    records: z.number(),
  }),
  memberEntity,
);
