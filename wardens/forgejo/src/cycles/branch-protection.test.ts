import { describe, it, expect } from "vitest";
import { branchProtectionCycle, buildBPBody } from "./branch-protection.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("buildBPBody", () => {
  it("maps fields and includes rule_name only on create", () => {
    const cfg = { ruleName: "main", requiredApprovals: 2, enableStatusCheck: true, statusCheckContexts: ["ci"] };
    expect(buildBPBody(cfg, true)).toEqual({
      rule_name: "main",
      required_approvals: 2,
      enable_status_check: true,
      status_check_contexts: ["ci"],
    });
    expect(buildBPBody(cfg, false)).not.toHaveProperty("rule_name");
  });
});

describe("branchProtectionCycle.buildDesired", () => {
  it("keeps only repos with branchProtection, stripping scalar fields", () => {
    const cfg = {
      repos: {
        api: { description: "ignored", branchProtection: [{ ruleName: "main" }] },
        web: { description: "no bp" },
      },
    };
    expect(branchProtectionCycle.buildDesired(cfg, "acme", scope)).toEqual({
      repos: { api: { branchProtection: [{ ruleName: "main" }] } },
    });
  });
  it("returns empty when no repo declares branch protection", () => {
    expect(branchProtectionCycle.buildDesired({ repos: { web: { description: "x" } } }, "acme", scope)).toEqual({});
  });
});

describe("branchProtectionCycle.fetchLive", () => {
  it("lists repos and maps each repo's protections (only the bp slice)", async () => {
    const client = makeClient({
      "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api" }],
      "GET /repos/acme/api/branch_protections?limit=50&page=1": [
        { rule_name: "main", required_approvals: 1, enable_status_check: true },
      ],
    });
    const live = await branchProtectionCycle.fetchLive(client, "acme", scope, makeBudget());
    expect(live.repos!.api).toEqual({
      branchProtection: [{ ruleName: "main", requiredApprovals: 1, enableStatusCheck: true }],
    });
  });
});

describe("branchProtectionCycle.apply", () => {
  it("create POSTs with rule_name", async () => {
    const client = makeClient();
    await branchProtectionCycle.apply(
      client,
      { kind: "create", resourceType: "branch-protection", key: "api/main", after: { ruleName: "main", requiredApprovals: 2 } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/repos/acme/api/branch_protections",
      body: { rule_name: "main", required_approvals: 2 },
    });
  });
  it("update PATCHes by rule name (url-encoded glob)", async () => {
    const client = makeClient();
    await branchProtectionCycle.apply(
      client,
      { kind: "update", resourceType: "branch-protection", key: "api/release/*", before: {}, after: { ruleName: "release/*", enablePush: false }, fields: [] },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({
      method: "PATCH",
      path: "/repos/acme/api/branch_protections/release%2F*",
      body: { enable_push: false },
    });
  });
  it("delete DELETEs by rule name", async () => {
    const client = makeClient();
    await branchProtectionCycle.apply(
      client,
      { kind: "delete", resourceType: "branch-protection", key: "api/main", before: { ruleName: "main" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/repos/acme/api/branch_protections/main" });
  });
});

describe("branchProtectionCycle via runReconcile", () => {
  it("creates a missing rule end-to-end without touching repo settings", async () => {
    const config: GovernanceConfig = {
      orgs: { acme: { repos: { api: { description: "x", branchProtection: [{ ruleName: "main", requiredApprovals: 1 }] } } } },
    };
    const client = makeClient({
      "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api" }],
      "GET /repos/acme/api/branch_protections?limit=50&page=1": [],
    });
    const result = await runReconcile({ config, client, cycles: [branchProtectionCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    // no PATCH /repos/acme/api (repo-scalar) was emitted
    expect(client.calls.some((c) => c.method === "PATCH" && c.path === "/repos/acme/api")).toBe(false);
    expect(client.calls.some((c) => c.method === "POST" && c.path === "/repos/acme/api/branch_protections")).toBe(true);
  });
});
