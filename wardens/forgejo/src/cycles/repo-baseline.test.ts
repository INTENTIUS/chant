import { describe, it, expect } from "vitest";
import { repoBaselineCycle } from "./repo-baseline.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("repoBaselineCycle.fetchLive", () => {
  it("records existing repo names", async () => {
    const client = makeClient({ "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api" }, { name: "web" }] });
    const live = await repoBaselineCycle.fetchLive(client, "acme", scope, makeBudget());
    expect(Object.keys(live.repos!).sort()).toEqual(["api", "web"]);
  });
});

describe("repoBaselineCycle.apply", () => {
  it("creates an empty private repo by default", async () => {
    const client = makeClient();
    await repoBaselineCycle.apply(
      client,
      { kind: "create", resourceType: "repo-baseline", key: "svc", after: { name: "svc" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/orgs/acme/repos", body: { name: "svc", private: true } });
  });
  it("generates from a template when set", async () => {
    const client = makeClient();
    await repoBaselineCycle.apply(
      client,
      { kind: "create", resourceType: "repo-baseline", key: "svc", after: { name: "svc", template: "tmpl/base", private: false } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/repos/tmpl/base/generate",
      body: { owner: "acme", name: "svc", private: false },
    });
  });
  it("ignores non-create / foreign entries", async () => {
    const client = makeClient();
    await repoBaselineCycle.apply(client, { kind: "create", resourceType: "repo", key: "x", after: {} }, "acme", scope, makeBudget());
    expect(client.calls).toHaveLength(0);
  });
});

describe("repoBaselineCycle via runReconcile", () => {
  it("creates only the missing baseline repo", async () => {
    const config: GovernanceConfig = {
      orgs: { acme: { repoBaselines: [{ name: "api" }, { name: "new-svc" }] } },
    };
    const client = makeClient({ "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api" }] });
    const result = await runReconcile({ config, client, cycles: [repoBaselineCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.find((c) => c.method === "POST")!.body).toMatchObject({ name: "new-svc" });
  });
});
