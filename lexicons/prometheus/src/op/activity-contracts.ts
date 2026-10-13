/**
 * Activity contracts for this lexicon's `op/activities` (#3369).
 *
 * Resolved by convention at
 * `@intentius/chant-lexicon-prometheus/op/activity-contracts`:
 * `loadActivityContracts` merges them into the map OPS012 checks each step's
 * args against and OPS013 checks each step-output reference against. Every
 * activity here has one; `rulesLoadedObserve`'s return schema is what lets a
 * `ConvergeOp({ observe: rulesLoadedObserve(...) })` pass OPS013, and
 * `alertmanagerSilence`'s is what a later step reads `.out.silenceId` from.
 *
 * Each `args` schema mirrors the `*Args` interface in `./activities/`,
 * without the `_`-prefixed test seams, and is a `z.strictObject`, so a
 * misspelled key fails the build.
 */

import { z } from "zod";
import { activityContract } from "@intentius/chant/op";

const oneOrMany = z.union([z.string(), z.array(z.string())]);
const toolResult = z.object({ files: z.array(z.string()), ok: z.boolean(), output: z.string() });
const resourceStatus = z.enum(["in-sync", "drifted", "unknown"]);

export const promtoolCheckRulesContract = activityContract(
  "promtoolCheckRules",
  z.strictObject({ rules: oneOrMany, bin: z.string().optional() }),
  toolResult,
);

export const promtoolTestRulesContract = activityContract(
  "promtoolTestRules",
  z.strictObject({ rules: z.string(), tests: oneOrMany.optional(), testYaml: oneOrMany.optional(), bin: z.string().optional() }),
  toolResult.extend({ tests: z.number() }),
);

export const amtoolCheckConfigContract = activityContract(
  "amtoolCheckConfig",
  z.strictObject({ config: z.string(), bin: z.string().optional() }),
  toolResult,
);

export const amtoolRoutesTestContract = activityContract(
  "amtoolRoutesTest",
  z.strictObject({ config: z.string(), labels: z.record(z.string(), z.string()), expect: oneOrMany, bin: z.string().optional() }),
  z.object({ config: z.string(), labels: z.record(z.string(), z.string()), receivers: z.array(z.string()), ok: z.boolean() }),
);

const record = { record: z.string().optional(), recordDir: z.string().optional() };

export const alertmanagerSilenceContract = activityContract(
  "alertmanagerSilence",
  z.strictObject({
    url: z.string().optional(),
    matchers: z.union([z.array(z.string()), z.record(z.string(), z.string())]),
    duration: z.string(),
    comment: z.string().optional(),
    createdBy: z.string().optional(),
    ...record,
  }),
  z.object({ silenceId: z.string(), url: z.string(), startsAt: z.string(), endsAt: z.string(), record: z.string() }),
);

export const alertmanagerUnsilenceContract = activityContract(
  "alertmanagerUnsilence",
  z.strictObject({ url: z.string().optional(), silenceId: z.string().optional(), ...record }),
  z.object({ expired: z.array(z.string()), failed: z.array(z.object({ silenceId: z.string(), detail: z.string() })) }),
);

export const rulesLoadedObserveContract = activityContract(
  "rulesLoadedObserve",
  z.strictObject({ url: z.string().optional(), groups: z.array(z.string()).optional(), rules: oneOrMany.optional(), timeoutMs: z.number().optional() }),
  z.object({ resources: z.array(z.object({ name: z.string(), status: resourceStatus, detail: z.string() })) }),
);

export const ruleAuditContract = activityContract(
  "ruleAudit",
  z.strictObject({
    url: z.string().optional(),
    pendingFor: z.string().optional(),
    firingFor: z.string().optional(),
    selectorBudget: z.number().optional(),
    lookback: z.string().optional(),
    mode: z.enum(["report", "issue"]).optional(),
    issueTitle: z.string().optional(),
  }),
  z.object({
    mode: z.enum(["report", "issue"]),
    findings: z.array(
      z.object({ kind: z.enum(["rule-error", "pending-too-long", "firing-too-long", "selector-no-series"]), subject: z.string(), detail: z.string() }),
    ),
    queried: z.number(),
    unchecked: z.number(),
    summary: z.string(),
    issueUrl: z.string().optional(),
  }),
);
