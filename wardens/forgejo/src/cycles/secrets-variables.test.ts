import { describe, it, expect } from "vitest";
import { secretsVariablesCycle } from "./secrets-variables.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("secretsVariablesCycle.fetchLive", () => {
  it("collects org + repo secrets (names) and variables (name+value)", async () => {
    const client = makeClient({
      "GET /orgs/acme/actions/secrets?limit=50&page=1": [{ name: "TOKEN" }],
      "GET /orgs/acme/actions/variables?limit=50&page=1": [{ name: "ENV", data: "prod" }],
      "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api" }],
      "GET /repos/acme/api/actions/secrets?limit=50&page=1": [{ name: "DEPLOY_KEY" }],
      "GET /repos/acme/api/actions/variables?limit=50&page=1": [{ name: "REGION", data: "eu" }],
    });
    const live = await secretsVariablesCycle.fetchLive(client, "acme", scope, makeBudget());
    expect(live.secrets).toEqual([{ name: "TOKEN" }]);
    expect(live.variables).toEqual([{ name: "ENV", value: "prod" }]);
    expect(live.repos!.api).toEqual({ secrets: [{ name: "DEPLOY_KEY" }], variables: [{ name: "REGION", value: "eu" }] });
  });
});

describe("secretsVariablesCycle.buildDesired", () => {
  it("keeps org secrets/vars and per-repo slices only", () => {
    const cfg = {
      secrets: [{ name: "T" }],
      repos: { api: { description: "x", variables: [{ name: "R", value: "eu" }] }, web: { description: "none" } },
    };
    expect(secretsVariablesCycle.buildDesired(cfg, "acme", scope)).toEqual({
      secrets: [{ name: "T" }],
      repos: { api: { variables: [{ name: "R", value: "eu" }] } },
    });
  });
});

describe("secretsVariablesCycle.apply", () => {
  it("org variable create POSTs the value", async () => {
    const client = makeClient();
    await secretsVariablesCycle.apply(
      client,
      { kind: "create", resourceType: "org-variable", key: "ENV", after: { name: "ENV", value: "prod" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/orgs/acme/actions/variables/ENV", body: { value: "prod" } });
  });
  it("repo variable update PUTs the value", async () => {
    const client = makeClient();
    await secretsVariablesCycle.apply(
      client,
      { kind: "update", resourceType: "repo-variable", key: "api/REGION", before: { name: "REGION", value: "us" }, after: { name: "REGION", value: "eu" }, fields: [] },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PUT", path: "/repos/acme/api/actions/variables/REGION", body: { value: "eu" } });
  });
  it("org secret create PUTs presence (value from env, default empty)", async () => {
    const client = makeClient();
    await secretsVariablesCycle.apply(
      client,
      { kind: "create", resourceType: "org-secret", key: "TOKEN", after: { name: "TOKEN" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PUT", path: "/orgs/acme/actions/secrets/TOKEN", body: { data: "" } });
  });
  it("repo secret delete DELETEs", async () => {
    const client = makeClient();
    await secretsVariablesCycle.apply(
      client,
      { kind: "delete", resourceType: "repo-secret", key: "api/OLD", before: { name: "OLD" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/repos/acme/api/actions/secrets/OLD" });
  });
});

describe("secretsVariablesCycle via runReconcile", () => {
  it("reconciles a drifted org variable value", async () => {
    const config: GovernanceConfig = { orgs: { acme: { variables: [{ name: "ENV", value: "prod" }] } } };
    const client = makeClient({
      "GET /orgs/acme/actions/secrets?limit=50&page=1": [],
      "GET /orgs/acme/actions/variables?limit=50&page=1": [{ name: "ENV", data: "staging" }],
      "GET /orgs/acme/repos?limit=50&page=1": [],
    });
    const result = await runReconcile({ config, client, cycles: [secretsVariablesCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.find((c) => c.method === "PUT")!.body).toEqual({ value: "prod" });
  });
});
