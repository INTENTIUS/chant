import { describe, it, expect } from "vitest";
import { membershipCycle } from "./membership.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("membershipCycle.fetchLive", () => {
  it("paginates and maps login → username", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ login: `u${i}` }));
    const client = makeClient({
      "GET /orgs/acme/members?limit=50&page=1": page1,
      "GET /orgs/acme/members?limit=50&page=2": [{ login: "u50" }],
    });
    const live = await membershipCycle.fetchLive(client, "acme", scope, makeBudget());
    expect(live.members).toHaveLength(51);
    expect(live.members![50]).toEqual({ username: "u50" });
  });
  it("404 → no members", async () => {
    const client = makeClient({
      "GET /orgs/ghost/members?limit=50&page=1": () => {
        throw new Error("GET returned 404");
      },
    });
    expect((await membershipCycle.fetchLive(client, "ghost", scope, makeBudget())).members).toEqual([]);
  });
});

describe("membershipCycle.apply", () => {
  it("delete removes the org member", async () => {
    const client = makeClient();
    await membershipCycle.apply(
      client,
      { kind: "delete", resourceType: "member", key: "bob", before: { username: "bob" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/orgs/acme/members/bob" });
  });
  it("create fails loudly (team-driven)", async () => {
    const client = makeClient();
    await expect(
      membershipCycle.apply(
        client,
        { kind: "create", resourceType: "member", key: "alice", after: { username: "alice" } },
        "acme",
        scope,
        makeBudget(),
      ),
    ).rejects.toThrow(/team-driven/);
    expect(client.calls).toHaveLength(0);
  });
});

describe("membershipCycle via runReconcile", () => {
  it("an unaddable member surfaces as a failed entry, run continues", async () => {
    const config: GovernanceConfig = { orgs: { acme: { members: [{ username: "alice" }] } } };
    const client = makeClient({ "GET /orgs/acme/members?limit=50&page=1": [] });
    const result = await runReconcile({ config, client, cycles: [membershipCycle], mode: "apply" });
    expect(result.cycles[0]!.failed).toHaveLength(1);
    expect(result.cycles[0]!.failed[0]!.error).toMatch(/team-driven/);
    expect(result.cycles[0]!.applied).toHaveLength(0);
  });
  it("removes an owned member not in config", async () => {
    const config: GovernanceConfig = { orgs: { acme: { members: [{ username: "keep" }] } } };
    const client = makeClient({
      "GET /orgs/acme/members?limit=50&page=1": [{ login: "keep" }, { login: "drop" }],
    });
    const result = await runReconcile({
      config,
      client,
      cycles: [membershipCycle],
      mode: "apply",
      diffOptions: { isOwned: () => true },
      removalDeltaCapFraction: 1, // allow the single removal in this 2-member org
    });
    expect(result.cycles[0]!.applied).toHaveLength(1);
    expect(client.calls.find((c) => c.method === "DELETE")!.path).toBe("/orgs/acme/members/drop");
  });
});
