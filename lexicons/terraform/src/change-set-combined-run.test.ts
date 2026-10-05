/**
 * One change set for a combined run, and the gate binds its digest (#3181).
 *
 * The workspace has three members: `delivery`, a chant project on the aws
 * lexicon; `estate`, a choudoufu estate; and `warden`, a github-warden whose
 * plan is a reconcile change set in a file. One Op plans all three, joins
 * them with `composeChangeSet`, and gates the apply on the document's digest.
 *
 * The plans are the real fixtures the adapter tests pin: chant's `lifecycle
 * plan --json` against floci (`packages/core/src/__fixtures__/change-set`),
 * choudoufu 0.16.0's `show -json` and the change sets github-warden's
 * `reconcile --plan-json` wrote (`warden.plan.json`, github-warden#66). The
 * two planner activities that need a cloud are stand-ins returning what the
 * real ones return for those plans. `composeChangeSet` and
 * `readChangeSetPart` are the real activities. The scenario is #2300's on a
 * set: approve, change one member's plan, re-run, and the run stops naming
 * both digests.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { lifecyclePlanPart, type ChangeSetDocument } from "@intentius/chant/change-set";
import type { ChangeSet as LifecycleChangeSet } from "@intentius/chant/lifecycle/change-set";
import type { GateResolutionRecord, PendingGateRecord } from "@intentius/chant/lifecycle/gate-ledger";
import {
  composeChangeSet,
  gate,
  lifecyclePlanChangeSet,
  readChangeSetPart,
  runOpLocally,
  stepOutput,
  type ActivityProfile,
  type GateLedgerPort,
  type OpConfig,
} from "@intentius/chant/op";
import * as coreActivities from "@intentius/chant/op/activities";
import { terraformChangeSetPart } from "./change-set";
import { terraformPlan } from "./op/builders";

const REPO = join(import.meta.dirname, "..", "..", "..");
const CORE_FIXTURES = join(REPO, "packages", "core", "src", "__fixtures__", "change-set");
const TF_FIXTURES = join(import.meta.dirname, "__fixtures__", "change-set");
const PROFILES: Record<string, ActivityProfile> = {
  longInfra: { timeout: "5m", retry: { maximumAttempts: 1 } },
  fastIdempotent: { timeout: "5m", retry: { maximumAttempts: 1 } },
};

/** `chant approve` between two runs: a resolution the next run reads. */
function approvableLedger(): GateLedgerPort & { approve(planDigest: string, at: string): void } {
  const resolutions: GateResolutionRecord[] = [];
  const pending: PendingGateRecord[] = [];
  return {
    approve(planDigest, at) {
      resolutions.push({ version: 1, op: "combined-apply", gate: "approve-run", resolvedBy: "alex", timestamp: at, planDigest });
    },
    async read() {
      return { resolutions: [...resolutions], pending: [...pending] };
    },
    async appendPending(input) {
      const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
      pending.push(record);
      return { record, pushed: true };
    },
  };
}

function harness() {
  const estatePlan = JSON.parse(readFileSync(join(TF_FIXTURES, "choudoufu.plan.json"), "utf-8")) as {
    resource_changes: Array<{ address: string; change: { after: Record<string, unknown> | null } }>;
  };
  const deliveryPlan = JSON.parse(readFileSync(join(CORE_FIXTURES, "lifecycle-plan.floci.json"), "utf-8")) as LifecycleChangeSet;
  const applied: string[] = [];
  const documents: ChangeSetDocument[] = [];

  const activities = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>([
    ["composeChangeSet", async (args) => {
      const out = await coreActivities.composeChangeSet(args as never);
      documents.push(out.document);
      return out;
    }],
    ["readChangeSetPart", coreActivities.readChangeSetPart as never],
    // Stand-ins for the two planners that need a cloud, returning what the real activities return.
    ["terraformPlan", async (args) => ({
      planFile: "chant.tfplan",
      changeSet: terraformChangeSetPart({ member: String(args.root), plan: estatePlan, planner: "choudoufu", scope: "est-estate" }),
    })],
    ["lifecyclePlanChangeSet", async (args) => ({ part: lifecyclePlanPart({ member: String(args.member), plan: deliveryPlan }) })],
    ["applyAll", async () => { applied.push("applied"); return {}; }],
  ]);

  const estate = terraformPlan("estate", { id: "estate" });
  const delivery = lifecyclePlanChangeSet({ member: "delivery", env: "dev", id: "delivery" });
  const warden = readChangeSetPart({ member: "warden", planner: "warden", file: join(CORE_FIXTURES, "warden.plan.json"), id: "warden" });
  const changeSet = composeChangeSet({
    parts: [estate.out.changeSet, delivery.out.part, warden.out.part],
    id: "change-set",
  });
  const config: OpConfig = {
    name: "combined-apply",
    overview: "",
    phases: [
      { name: "Plan", steps: [estate, delivery, warden, changeSet] },
      { name: "Approve", steps: [gate("approve-run", { plan: stepOutput("change-set", "digest") })] },
      { name: "Apply", steps: [{ kind: "activity", fn: "applyAll", args: {} }] },
    ],
  };
  /** The document the latest run composed. */
  const latest = (): ChangeSetDocument => documents[documents.length - 1];
  return { estatePlan, applied, activities, config, latest };
}

describe("a combined run over a chant member, a choudoufu member and a warden (#3181)", () => {
  test("one change set, and the gate records its digest", async () => {
    const { activities, config, applied, latest } = harness();
    const gates = approvableLedger();
    const first = await runOpLocally(config, activities, PROFILES, undefined, { gates, now: "2026-10-03T12:00:00.000Z" });
    expect(first.status).toBe("gated");
    expect(applied).toEqual([]);

    const doc = latest();
    expect(doc.members.map((m) => [m.member, m.planner])).toEqual([["delivery", "chant"], ["estate", "choudoufu"], ["warden", "warden"]]);
    expect(doc.summary.deletes.map((d) => `${d.member}:${d.address}`)).toEqual(["estate:terraform_data.old", "warden:team.contractors"]);
    expect(first.gate?.planDigest).toBe(doc.digest);
  });

  test("approve the digest, re-run unchanged, and it applies", async () => {
    const { activities, config, applied, latest } = harness();
    const gates = approvableLedger();
    await runOpLocally(config, activities, PROFILES, undefined, { gates, now: "2026-10-03T12:00:00.000Z" });
    gates.approve(latest().digest, "2026-10-03T12:05:00.000Z");
    const second = await runOpLocally(config, activities, PROFILES, undefined, { gates, now: "2026-10-03T12:10:00.000Z" });
    expect(second.status).toBe("ok");
    expect(applied).toEqual(["applied"]);
  });

  test("approve, change the choudoufu member's plan, re-run: the run stops, naming both digests", async () => {
    const { estatePlan, activities, config, applied, latest } = harness();
    const gates = approvableLedger();
    await runOpLocally(config, activities, PROFILES, undefined, { gates, now: "2026-10-03T12:00:00.000Z" });
    const approved = latest().digest;
    gates.approve(approved, "2026-10-03T12:05:00.000Z");

    // The estate's config input moves from "large" to "xlarge": one value in one member.
    const config2 = estatePlan.resource_changes.find((r) => r.address === "terraform_data.config")!;
    config2.change.after = { ...config2.change.after, input: { size: "xlarge", tags: { team: "core" } } };

    const second = await runOpLocally(config, activities, PROFILES, undefined, { gates, now: "2026-10-03T12:10:00.000Z" });
    const planned = latest().digest;
    expect(planned).not.toBe(approved);
    expect(second.status).toBe("gated");
    expect(applied).toEqual([]);
    const refusal = second.records.find((r) => r.fn === "gate:approve-run")?.refusal;
    expect(refusal).toContain(`approved: ${approved}`);
    expect(refusal).toContain(`planned: ${planned}`);
  });
});
