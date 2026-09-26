/**
 * Activity contracts for this lexicon's `op/activities` (the build-time half,
 * as `lexicons/terraform/src/op/activity-contracts.ts` is for terraform).
 * Core's OPS012 validates every `decide` step's args against `decide` below
 * and OPS013 a later step's reference into its result, so a misspelled `point`
 * or a key written as a literal string fails `chant build` rather than a run.
 */

import { z } from "zod";
import { activityContract } from "@intentius/chant/op";
import { backendSchema } from "../config";

const escalation = z.object({ kind: z.enum(["table", "model"]), reason: z.string() }).loose();

export const decide = activityContract(
  "decide",
  z.strictObject({
    point: z.string().min(1),
    inputs: z.record(z.string(), z.unknown()).optional(),
    read: z.record(z.string(), z.string()).optional(),
    subject: z.string().optional(),
    kind: z.string().optional(),
    cwd: z.string().optional(),
    backends: z.record(z.string(), backendSchema).optional(),
    dryRun: z.boolean().optional(),
  }),
  z.strictObject({
    id: z.string(),
    path: z.string(),
    state: z.enum(["escalated", "proposed", "answered"]),
    open: z.boolean(),
    answer: z.union([z.string(), z.boolean(), z.null()]),
    decider: z.string(),
    model: z.string().nullable(),
    backend: z.string().nullable(),
    confidence: z.number().nullable(),
    threshold: z.number().nullable(),
    answeredBy: z.array(z.string()),
    escalations: z.array(escalation),
    missing: z.array(z.string()),
  }),
  { entities: ["point"] },
);
