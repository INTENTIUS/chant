import { describe, it, expect } from "vitest";
import { webhooksCycle, buildHookBody } from "./webhooks.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("buildHookBody", () => {
  it("nests url/content_type under config; type only on create", () => {
    const w = { url: "https://h", contentType: "form" as const, events: ["push"], active: true };
    expect(buildHookBody(w, true)).toEqual({
      type: "forgejo",
      config: { url: "https://h", content_type: "form" },
      events: ["push"],
      active: true,
    });
    expect(buildHookBody(w, false)).not.toHaveProperty("type");
  });
});

describe("webhooksCycle.fetchLive", () => {
  it("maps org + repo hooks, carrying id and url from config.url", async () => {
    const client = makeClient({
      "GET /orgs/acme/hooks?limit=50&page=1": [
        { id: 3, type: "forgejo", active: true, events: ["push"], config: { url: "https://org", content_type: "json" } },
      ],
      "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api" }],
      "GET /repos/acme/api/hooks?limit=50&page=1": [
        { id: 9, config: { url: "https://repo", content_type: "form" } },
      ],
    });
    const live = await webhooksCycle.fetchLive(client, "acme", scope, makeBudget());
    expect(live.webhooks).toEqual([{ id: 3, url: "https://org", type: "forgejo", contentType: "json", events: ["push"], active: true }]);
    expect(live.repos!.api.webhooks).toEqual([{ id: 9, url: "https://repo", contentType: "form" }]);
  });
});

describe("webhooksCycle.apply", () => {
  it("org create POSTs the hook", async () => {
    const client = makeClient();
    await webhooksCycle.apply(
      client,
      { kind: "create", resourceType: "org-webhook", key: "https://h", after: { url: "https://h", events: ["push"] } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/orgs/acme/hooks" });
    expect(client.calls[0]!.body).toMatchObject({ type: "forgejo", config: { url: "https://h" } });
  });
  it("repo update PATCHes by live id (key strips the repo prefix)", async () => {
    const client = makeClient();
    await webhooksCycle.apply(
      client,
      {
        kind: "update",
        resourceType: "repo-webhook",
        key: "api/https://h/path",
        before: { id: 9, url: "https://h/path" },
        after: { url: "https://h/path", active: false },
        fields: [],
      },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PATCH", path: "/repos/acme/api/hooks/9", body: { active: false } });
  });
  it("org delete DELETEs by id", async () => {
    const client = makeClient();
    await webhooksCycle.apply(
      client,
      { kind: "delete", resourceType: "org-webhook", key: "https://h", before: { id: 3, url: "https://h" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/orgs/acme/hooks/3" });
  });
  it("throws when an update/delete lacks a live id", async () => {
    const client = makeClient();
    await expect(
      webhooksCycle.apply(
        client,
        { kind: "delete", resourceType: "org-webhook", key: "https://h", before: { url: "https://h" } },
        "acme",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow(/no live id/);
  });
});

describe("webhooksCycle via runReconcile", () => {
  it("creates a missing org webhook end-to-end", async () => {
    const config: GovernanceConfig = { orgs: { acme: { webhooks: [{ url: "https://new", events: ["push"] }] } } };
    const client = makeClient({
      "GET /orgs/acme/hooks?limit=50&page=1": [],
      "GET /orgs/acme/repos?limit=50&page=1": [],
    });
    const result = await runReconcile({ config, client, cycles: [webhooksCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.find((c) => c.method === "POST")!.path).toBe("/orgs/acme/hooks");
  });
});
