/**
 * Activity contracts for this lexicon's `op/activities` (#3369).
 *
 * Resolved by convention at `@intentius/chant-lexicon-otel/op/activity-contracts`:
 * `loadActivityContracts` merges them into the map OPS012 checks each step's
 * args against and OPS013 checks each step-output reference against. Every
 * activity here has one. `collectorHealthObserve` needs its return schema
 * most: it is the observer of a `ConvergeOp({ observe })`, whose Converge
 * step reads the observer's whole output.
 *
 * Each `args` schema mirrors the `*Args` interface in `./activities/`,
 * without the `_`-prefixed test seams, and is a `z.strictObject`, so a
 * misspelled key fails the build.
 */

import { z } from "zod";
import { activityContract } from "@intentius/chant/op";

const componentKind = z.enum(["receiver", "processor", "exporter", "connector", "extension"]);
const byKind = z.object({
  receiver: z.array(z.string()),
  processor: z.array(z.string()),
  exporter: z.array(z.string()),
  connector: z.array(z.string()),
  extension: z.array(z.string()),
});

export const otelcolValidateContract = activityContract(
  "otelcolValidate",
  z.strictObject({ config: z.string(), bin: z.string().optional(), version: z.string().optional() }),
  z.object({ config: z.string(), bin: z.string(), version: z.string(), ok: z.boolean(), output: z.string() }),
);

export const otelcolComponentsContract = activityContract(
  "otelcolComponents",
  z.strictObject({ config: z.string(), bin: z.string().optional() }),
  z.object({
    config: z.string(),
    bin: z.string(),
    version: z.string().optional(),
    used: byKind,
    missing: z.array(z.object({ kind: componentKind, id: z.string(), type: z.string() })),
  }),
);

const endpointOverrides = z.strictObject({ healthCheck: z.string().optional(), zpages: z.string().optional(), telemetry: z.string().optional() });

export const collectorHealthObserveContract = activityContract(
  "collectorHealthObserve",
  z.strictObject({
    collectors: z.array(
      z.strictObject({
        name: z.string(),
        config: z.string().optional(),
        configObject: z.record(z.string(), z.unknown()).optional(),
        host: z.string().optional(),
        endpoints: endpointOverrides.optional(),
      }),
    ),
    timeoutMs: z.number().optional(),
    probes: z.number().optional(),
    probeIntervalMs: z.number().optional(),
  }),
  z.object({
    resources: z.array(z.object({ name: z.string(), status: z.enum(["in-sync", "drifted", "unknown"]), detail: z.string() })),
  }),
);

const pinState = z.object({ pin: z.string(), latest: z.string().nullable(), behind: z.number() });

export const collectorAuditContract = activityContract(
  "collectorAudit",
  z.strictObject({
    mode: z.enum(["report", "issue", "pull-request"]).optional(),
    lexiconDir: z.string().optional(),
    stability: z.boolean().optional(),
    stabilityBudget: z.number().optional(),
    branch: z.string().optional(),
  }),
  z.object({
    mode: z.enum(["report", "issue", "pull-request"]),
    collector: pinState,
    semconv: pinState,
    findings: z.array(
      z.object({ kind: z.enum(["collector-pin-behind", "semconv-pin-behind", "stability-changed", "deprecated"]), subject: z.string(), detail: z.string() }),
    ),
    unchecked: z.array(z.string()),
    summary: z.string(),
    issueUrl: z.string().optional(),
    prUrl: z.string().optional(),
  }),
);
