import { describe, it, expect } from "vitest";
import { teamsCycle, buildTeamBody } from "./teams.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("buildTeamBody", () => {
  it("maps camelCase to Forgejo snake_case", () => {
    expect(buildTeamBody({ permission: "write", canCreateOrgRepo: true, units: ["repo.code"] })).toEqual({
      permission: "write",
      can_create_org_repo: true,
      units: ["repo.code"],
    });
  });
});

describe("teamsCycle.fetchLive", () => {
  it("lists teams with members and repos, carrying the id", async () => {
    const client = makeClient({
      "GET /orgs/acme/teams?limit=50&page=1": [
        { id: 7, name: "devs", permission: "write", can_create_org_repo: true, units: ["repo.code"] },
      ],
      "GET /teams/7/members?limit=50&page=1": [{ login: "alice" }, { login: "bob" }],
      "GET /teams/7/repos?limit=50&page=1": [{ name: "api" }],
    });
    const live = await teamsCycle.fetchLive(client, "acme", scope, makeBudget());
    expect(live.teams!.devs).toMatchObject({
      id: 7,
      permission: "write",
      canCreateOrgRepo: true,
      members: [{ username: "alice" }, { username: "bob" }],
      repos: [{ name: "api" }],
    });
  });
});

describe("teamsCycle.apply — team create embeds children", () => {
  it("POSTs the team then PUTs members and repos with the new id", async () => {
    const client = makeClient({ "POST /orgs/acme/teams": { id: 42 } });
    await teamsCycle.apply(
      client,
      {
        kind: "create",
        resourceType: "team",
        key: "devs",
        after: { permission: "write", members: [{ username: "alice" }], repos: [{ name: "api" }] },
      },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /orgs/acme/teams",
      "PUT /teams/42/members/alice",
      "PUT /teams/42/repos/acme/api",
    ]);
    expect(client.calls[0]!.body).toMatchObject({ name: "devs", permission: "write" });
  });
});

describe("teamsCycle.apply — update/delete use the live id", () => {
  it("PATCHes /teams/{id} on update", async () => {
    const client = makeClient();
    await teamsCycle.apply(
      client,
      { kind: "update", resourceType: "team", key: "devs", before: { id: 7 }, after: { permission: "admin" }, fields: [] },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PATCH", path: "/teams/7", body: { permission: "admin" } });
  });
  it("DELETEs /teams/{id} on delete", async () => {
    const client = makeClient();
    await teamsCycle.apply(
      client,
      { kind: "delete", resourceType: "team", key: "devs", before: { id: 7 } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/teams/7" });
  });
});

describe("teamsCycle.apply — subresources resolve name → id", () => {
  it("team-member add resolves the team id first", async () => {
    const client = makeClient({ "GET /orgs/acme/teams/devs": { id: 9 } });
    await teamsCycle.apply(
      client,
      { kind: "create", resourceType: "team-member", key: "devs/carol", after: { username: "carol" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /orgs/acme/teams/devs",
      "PUT /teams/9/members/carol",
    ]);
  });
  it("team-repo remove resolves id then DELETEs", async () => {
    const client = makeClient({ "GET /orgs/acme/teams/devs": { id: 9 } });
    await teamsCycle.apply(
      client,
      { kind: "delete", resourceType: "team-repo", key: "devs/api", before: { name: "api" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[1]).toMatchObject({ method: "DELETE", path: "/teams/9/repos/acme/api" });
  });
});

describe("teamsCycle via runReconcile", () => {
  it("creates a missing team end-to-end", async () => {
    const config: GovernanceConfig = {
      orgs: { acme: { teams: { devs: { permission: "write", members: [{ username: "alice" }] } } } },
    };
    const client = makeClient({
      "GET /orgs/acme/teams?limit=50&page=1": [],
      "POST /orgs/acme/teams": { id: 100 },
    });
    const result = await runReconcile({ config, client, cycles: [teamsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.some((c) => c.path === "PUT /teams/100/members/alice".split(" ")[1])).toBe(true);
  });
});
