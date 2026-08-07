import { describe, it, expect } from "vitest";
import { orgSettingsCycle, buildOrgPatchBody } from "./org-settings.js";
import type { OrgSettingsScope } from "./org-settings.js";
import type { ForgejoClient } from "../auth/client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { runReconcile, BudgetExhaustedError } from "../reconcile/runner.js";
import { diff } from "../reconcile/diff.js";
import type { LiveOrgState } from "../reconcile/live.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";

interface MockCall {
  method: string;
  path: string;
  body?: unknown;
}
interface MockClient extends ForgejoClient {
  calls: MockCall[];
}
function makeClient(responses: Record<string, unknown> = {}): MockClient {
  const calls: MockCall[] = [];
  const map = new Map(Object.entries(responses));
  return {
    calls,
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      return (map.has(key) ? map.get(key) : {}) as T;
    },
  };
}
function makeBudget(n = 100): RateBudget {
  let r = n;
  return {
    get remaining() {
      return r;
    },
    get exhausted() {
      return r <= 0;
    },
    use(k = 1) {
      if (r <= 0) throw new BudgetExhaustedError();
      r = Math.max(0, r - k);
    },
  };
}
const scope: OrgSettingsScope = {};

describe("buildOrgPatchBody", () => {
  it("maps declared fields to Forgejo snake_case", () => {
    expect(buildOrgPatchBody({ fullName: "Acme", visibility: "private", repoAdminChangeTeamAccess: false })).toEqual({
      full_name: "Acme",
      visibility: "private",
      repo_admin_change_team_access: false,
    });
  });
  it("omits undeclared fields", () => {
    expect(buildOrgPatchBody({ description: "d" })).toEqual({ description: "d" });
  });
});

describe("orgSettingsCycle.fetchLive", () => {
  it("maps the org GET response", async () => {
    const client = makeClient({
      "GET /orgs/acme": { full_name: "Acme", visibility: "limited", repo_admin_change_team_access: true, description: "x" },
    });
    const live = await orgSettingsCycle.fetchLive(client, "acme", scope, makeBudget());
    expect(live.settings).toEqual({ fullName: "Acme", visibility: "limited", repoAdminChangeTeamAccess: true, description: "x" });
  });
  it("treats 404 as empty", async () => {
    const client: MockClient = makeClient();
    client.request = async () => {
      throw new Error("GET /orgs/ghost returned 404: Not Found");
    };
    expect((await orgSettingsCycle.fetchLive(client, "ghost", scope, makeBudget())).settings).toBeUndefined();
  });
});

describe("orgSettingsCycle.buildDesired", () => {
  it("keeps only settings", () => {
    const cfg: OrgConfig = { settings: { description: "d" }, members: [{ username: "a" }] };
    expect(orgSettingsCycle.buildDesired(cfg, "acme", scope)).toEqual({ settings: { description: "d" } });
  });
});

describe("orgSettingsCycle.apply", () => {
  it("PATCHes declared fields", async () => {
    const client = makeClient();
    await orgSettingsCycle.apply(
      client,
      { kind: "update", resourceType: "org-settings", key: "org-settings", after: { description: "new" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PATCH", path: "/orgs/acme", body: { description: "new" } });
  });
  it("ignores delete and foreign entries", async () => {
    const client = makeClient();
    await orgSettingsCycle.apply(client, { kind: "delete", resourceType: "org-settings", key: "org-settings", before: {} }, "acme", scope, makeBudget());
    await orgSettingsCycle.apply(client, { kind: "create", resourceType: "team", key: "x", after: {} }, "acme", scope, makeBudget());
    expect(client.calls).toHaveLength(0);
  });
});

describe("orgSettingsCycle via runReconcile", () => {
  const config: GovernanceConfig = { orgs: { acme: { settings: { description: "want" } } } };
  it("dry-run reports the update without mutating", async () => {
    const client = makeClient({ "GET /orgs/acme": { description: "have" } });
    const result = await runReconcile({ config, client, cycles: [orgSettingsCycle], mode: "dry-run" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.update).toBe(1);
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("apply PATCHes after the GET", async () => {
    const client = makeClient({ "GET /orgs/acme": { description: "have" } });
    const result = await runReconcile({ config, client, cycles: [orgSettingsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.applied).toHaveLength(1);
    expect(client.calls.find((c) => c.method === "PATCH")!.body).toEqual({ description: "want" });
  });

  it("diff helper: live snapshot composes a valid change set", () => {
    const desired = orgSettingsCycle.buildDesired(config.orgs.acme!, "acme", scope);
    const live: LiveOrgState = { settings: { description: "have" } };
    expect(diff("acme", desired, live).entries[0]!.kind).toBe("update");
  });
});
