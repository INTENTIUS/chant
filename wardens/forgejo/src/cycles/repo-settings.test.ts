import { describe, it, expect } from "vitest";
import { repoSettingsCycle, buildRepoBody } from "./repo-settings.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("buildRepoBody", () => {
  it("maps declared fields to Forgejo snake_case, excluding topics", () => {
    expect(buildRepoBody({ hasIssues: false, defaultBranch: "main", allowSquashMerge: true, topics: ["x"] })).toEqual({
      has_issues: false,
      default_branch: "main",
      allow_squash_merge: true,
    });
  });
});

describe("repoSettingsCycle.fetchLive", () => {
  it("lists org repos and maps settings + topics", async () => {
    const client = makeClient({
      "GET /orgs/acme/repos?limit=50&page=1": [
        { name: "api", description: "svc", private: true, has_issues: true, topics: ["go"] },
      ],
    });
    const live = await repoSettingsCycle.fetchLive(client, "acme", scope, makeBudget());
    expect(live.repos!.api).toEqual({ description: "svc", private: true, hasIssues: true, topics: ["go"] });
  });
});

describe("repoSettingsCycle.apply", () => {
  it("PATCHes settings then PUTs topics", async () => {
    const client = makeClient();
    await repoSettingsCycle.apply(
      client,
      { kind: "update", resourceType: "repo", key: "api", before: {}, after: { description: "new", topics: ["go", "svc"] }, fields: [] },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /repos/acme/api",
      "PUT /repos/acme/api/topics",
    ]);
    expect(client.calls[0]!.body).toEqual({ description: "new" });
    expect(client.calls[1]!.body).toEqual({ topics: ["go", "svc"] });
  });
  it("skips the PATCH when only topics are declared", async () => {
    const client = makeClient();
    await repoSettingsCycle.apply(
      client,
      { kind: "update", resourceType: "repo", key: "api", before: {}, after: { topics: ["x"] }, fields: [] },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => c.method)).toEqual(["PUT"]);
  });
  it("ignores deletes and foreign resource types", async () => {
    const client = makeClient();
    await repoSettingsCycle.apply(client, { kind: "delete", resourceType: "repo", key: "api", before: {} }, "acme", scope, makeBudget());
    await repoSettingsCycle.apply(client, { kind: "create", resourceType: "team", key: "t", after: {} }, "acme", scope, makeBudget());
    expect(client.calls).toHaveLength(0);
  });
});

describe("repoSettingsCycle via runReconcile", () => {
  it("updates an existing repo's drifted settings", async () => {
    const config: GovernanceConfig = { orgs: { acme: { repos: { api: { hasIssues: true } } } } };
    const client = makeClient({
      "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api", has_issues: false }],
    });
    const result = await runReconcile({ config, client, cycles: [repoSettingsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.find((c) => c.method === "PATCH")!.body).toEqual({ has_issues: true });
  });
});
