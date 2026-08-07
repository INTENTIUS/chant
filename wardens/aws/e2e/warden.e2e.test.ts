/**
 * Gated end-to-end suite against a floci (AWS emulator) endpoint — see
 * e2e/bootstrap.sh. Skips entirely unless AWS_ENDPOINT_URL is set, so the
 * default test run and machines without Docker are unaffected.
 *
 * Phases:
 *   1 (always): create the org, dry-run the foundation config, assert the
 *     plan proposes the foundation; nothing mutates.
 *   2 (AWS_WARDEN_E2E_APPLY=1): apply, then re-run dry — the plan must be
 *     empty (idempotence: reconcile converges in one apply).
 *
 * Emulator gaps discovered here belong in test/floci-gaps.md. The
 * audit-trail cycle is deliberately not exercised: floci builds without the
 * cloudtrail service would fail its fetch, and the trail cycle has no diff
 * to make when the config declares no sink.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createClient, credentialsFromEnv, type AwsClient } from "../src/auth/client.js";
import { runReconcile } from "../src/reconcile/runner.js";
import { orgUnitsCycle } from "../src/cycles/org-units.js";
import { scpsCycle } from "../src/cycles/scps.js";
import type { AwsGovernanceConfig } from "../src/config/types.js";

const ENDPOINT = process.env.AWS_ENDPOINT_URL;
const APPLY = process.env.AWS_WARDEN_E2E_APPLY === "1";

const config: AwsGovernanceConfig = {
  organization: { scps: ["deny-leave-organization"] },
  ous: {
    Security: { scps: ["deny-audit-tamper"] },
    Workloads: { children: { Prod: {} } },
  },
  scps: {
    "deny-leave-organization": {
      description: "root guard",
      document: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "organizations:LeaveOrganization", Resource: "*" }] },
    },
    "deny-audit-tamper": {
      document: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: ["cloudtrail:StopLogging"], Resource: "*" }] },
    },
  },
};

describe.skipIf(!ENDPOINT)("aws-warden e2e (floci)", () => {
  let client: AwsClient;

  beforeAll(async () => {
    client = createClient(credentialsFromEnv());
    // Idempotent: CreateOrganization fails with AlreadyInOrganizationException
    // on a warm emulator, which is fine.
    await client.request("organizations", "CreateOrganization", { FeatureSet: "ALL" }).catch(() => {});
  });

  it("phase 1: dry-run proposes the foundation and mutates nothing", async () => {
    const result = await runReconcile({
      config,
      client,
      cycles: [orgUnitsCycle, scpsCycle],
      mode: "dry-run",
    });
    expect(result.errored).toEqual([]);
    const orgUnits = result.cycles.find((c) => c.name === "org-units");
    const scps = result.cycles.find((c) => c.name === "scps");
    expect(orgUnits!.counts.create).toBeGreaterThanOrEqual(3); // Security, Workloads, Workloads/Prod
    expect(scps!.counts.create).toBeGreaterThanOrEqual(2);
    expect(result.cycles.every((c) => c.applied.length === 0)).toBe(true);
  });

  it.skipIf(!APPLY)("phase 2: apply converges — the re-run plan is empty", async () => {
    const applyRun = await runReconcile({
      config,
      client,
      cycles: [orgUnitsCycle, scpsCycle],
      mode: "apply",
    });
    expect(applyRun.errored).toEqual([]);
    for (const c of applyRun.cycles) {
      expect(c.failed, `${c.name} failures: ${JSON.stringify(c.failed)}`).toEqual([]);
      expect(c.guardrailBlocked).toBe(false);
    }

    const reRun = await runReconcile({
      config,
      client,
      cycles: [orgUnitsCycle, scpsCycle],
      mode: "dry-run",
    });
    for (const c of reRun.cycles) {
      expect(c.counts, `${c.name} plan not empty:\n${c.plan}`).toEqual({ create: 0, update: 0, delete: 0 });
    }
  });
});
