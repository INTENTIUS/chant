/**
 * Tests for the Forgejo diff().
 */

import { describe, it, expect } from "vitest";
import { diff } from "./diff.js";
import type { OrgConfig } from "../config/types.js";
import type { LiveOrgState } from "./live.js";

const ORG = "acme";
const kinds = (d: OrgConfig, l: LiveOrgState, opts = {}) =>
  diff(ORG, d, l, opts).entries.map((e) => `${e.resourceType}:${e.kind}:${e.key}`);

describe("diff: org settings", () => {
  it("update when a field differs", () => {
    const cs = diff(ORG, { settings: { description: "new" } }, { settings: { description: "old" } });
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.kind).toBe("update");
    expect(cs.entries[0]!.fields).toEqual([{ field: "description", before: "old", after: "new" }]);
  });
  it("no entry when settings match / absent", () => {
    expect(diff(ORG, {}, { settings: { description: "x" } }).entries).toHaveLength(0);
    expect(diff(ORG, { settings: { description: "x" } }, { settings: { description: "x" } }).entries).toHaveLength(0);
  });
});

describe("diff: members (presence; team-driven)", () => {
  it("create for new member; ownership-gated delete", () => {
    const d: OrgConfig = { members: [{ username: "alice" }] };
    const l: LiveOrgState = { members: [{ username: "bob" }] };
    expect(kinds(d, l)).toEqual(["member:create:alice"]); // bob not deleted without ownership
    const owned = kinds(d, l, { isOwned: (_t: string, k: string) => k === "bob" });
    expect(owned).toContain("member:delete:bob");
  });
});

describe("diff: teams", () => {
  it("create a new team with embedded members/repos", () => {
    const d: OrgConfig = { teams: { devs: { permission: "write", members: [{ username: "a" }], repos: [{ name: "svc" }] } } };
    const cs = diff(ORG, d, { teams: {} });
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.resourceType).toBe("team");
    expect(cs.entries[0]!.kind).toBe("create");
    expect((cs.entries[0]!.after as { members?: unknown[] }).members).toHaveLength(1);
  });
  it("existing team → field update + separate child entries", () => {
    const d: OrgConfig = { teams: { devs: { permission: "admin", members: [{ username: "a" }], repos: [{ name: "svc" }] } } };
    const l: LiveOrgState = { teams: { devs: { id: 1, permission: "write", members: [], repos: [] } } };
    const ks = kinds(d, l);
    expect(ks).toContain("team:update:devs");
    expect(ks).toContain("team-member:create:devs/a");
    expect(ks).toContain("team-repo:create:devs/svc");
  });
});

describe("diff: repos + branch protection", () => {
  it("repo field + topics update; branch protection create/update", () => {
    const d: OrgConfig = {
      repos: {
        svc: {
          hasWiki: false,
          topics: ["api"],
          branchProtection: [{ ruleName: "main", requiredApprovals: 2, statusCheckContexts: ["ci"] }],
        },
      },
    };
    const l: LiveOrgState = {
      repos: { svc: { hasWiki: true, topics: ["old"], branchProtection: [{ ruleName: "main", requiredApprovals: 1, statusCheckContexts: [] }] } },
    };
    const ks = kinds(d, l);
    expect(ks).toContain("repo:update:svc");
    expect(ks).toContain("branch-protection:update:svc/main");
    const repoEntry = diff(ORG, d, l).entries.find((e) => e.resourceType === "repo")!;
    expect(repoEntry.fields!.map((f) => f.field).sort()).toEqual(["hasWiki", "topics"]);
  });
});

describe("diff: webhooks / secrets / variables", () => {
  it("org webhook create keyed by url", () => {
    const d: OrgConfig = { webhooks: [{ url: "https://h.test", events: ["push"] }] };
    expect(kinds(d, { webhooks: [] })).toEqual(["org-webhook:create:https://h.test"]);
  });
  it("secret presence (create only, no update) + variable value update", () => {
    const d: OrgConfig = { secrets: [{ name: "TOKEN" }], variables: [{ name: "ENV", value: "prod" }] };
    const l: LiveOrgState = { secrets: [], variables: [{ name: "ENV", value: "staging" }] };
    const ks = kinds(d, l);
    expect(ks).toContain("org-secret:create:TOKEN");
    expect(ks).toContain("org-variable:update:ENV");
  });
});

describe("diff: repo baselines (existence only)", () => {
  it("create only for missing repos", () => {
    const d: OrgConfig = { repoBaselines: [{ name: "exists" }, { name: "fresh" }] };
    const l: LiveOrgState = { repos: { exists: {} } };
    expect(kinds(d, l)).toEqual(["repo-baseline:create:fresh"]);
  });
});
