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

// PulumiAdoptOp's steps (#4562).
const adoptStackArgs = {
  member: z.string(),
  dir: z.string(),
  cwd: z.string().optional(),
  stack: z.string(),
};

const adoptPreviewReturns = {
  member: z.string(),
  stack: z.string(),
  status: z.enum(["would-adopt", "adopted", "already-adopted", "refused"]),
  planDigest: z.string(),
  checkpointDigest: z.string().nullable(),
  resources: z.number(),
  fates: z.record(z.string(), z.number()),
  changed: z.boolean(),
};

export const pulumiAdoptCheckContract = activityContract(
  "pulumiAdoptCheck",
  z.strictObject({
    ...adoptStackArgs,
    backend: z.string().optional(),
    bucket: z.record(z.string(), z.unknown()).optional(),
    namespaces: z.array(z.string()).optional(),
    allowInsecure: z.array(z.string()).optional(),
  }),
  z.object({
    member: z.string(),
    stack: z.string(),
    checked: z.boolean(),
    skipped: z.string().optional(),
    store: z.string().optional(),
    bucket: z.string().optional(),
    correct: z.boolean(),
    waived: z.array(z.string()),
  }),
  memberEntity,
);

export const pulumiAdoptExportContract = activityContract(
  "pulumiAdoptExport",
  z.strictObject({
    ...adoptStackArgs,
    backend: z.string().optional(),
    from: z.strictObject({ backend: z.string().optional(), file: z.string().optional() }).optional(),
  }),
  z.object({
    member: z.string(),
    stack: z.string(),
    file: z.string(),
    sha256: z.string(),
    resources: z.number(),
    pendingOperations: z.number(),
    source: z.string(),
    adoptFromFile: z.boolean(),
  }),
  memberEntity,
);

export const pulumiAdoptPreviewContract = activityContract(
  "pulumiAdoptPreview",
  z.strictObject({ ...adoptStackArgs, file: z.string().optional() }),
  z.object(adoptPreviewReturns),
  memberEntity,
);

export const pulumiAdoptContract = activityContract(
  "pulumiAdopt",
  z.strictObject({ ...adoptStackArgs, file: z.string().optional(), planDigest: z.string().optional() }),
  z.object({ ...adoptPreviewReturns, matchesApproved: z.boolean().optional() }),
  memberEntity,
);
