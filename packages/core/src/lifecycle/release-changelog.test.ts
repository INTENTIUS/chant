/**
 * The changelog from conventional commits (#4597): grouping, scopes, and a
 * bump that agrees with terragucci's `bumpFor` on its own cases
 * (terragucci `test/publish.test.ts`).
 */
import { describe, expect, test } from "vitest";
import { classifyCommit, changelogBump, releaseChangelog } from "./release-changelog";
import { buildReleaseCatalog } from "./release-catalog";

describe("changelogBump agrees with terragucci's bumpFor", () => {
  test.each([
    [["fix: a"], "patch"],
    [["fix: a", "feat(net): b"], "minor"],
    [["feat: b", "refactor!: c"], "major"],
    [["fix: a\n\nBREAKING CHANGE: gone"], "major"],
    [["chore: tidy"], "patch"],
    [[], "patch"],
    [["fix: a\n\nBREAKING-CHANGE: gone"], "major"],
    [["feat(vpc)!: drop ipv4"], "major"],
    [["Feat: capital"], "patch"],
  ] as const)("%j is a %s", (messages, bump) => {
    expect(changelogBump(messages)).toBe(bump);
    expect(releaseChangelog(messages.map((message, i) => ({ sha: `s${i}`, message }))).bump).toBe(bump);
  });
});

describe("classifyCommit", () => {
  test("reads the type, scope and description", () => {
    expect(classifyCommit("feat(net): add flow logs\n\nbody")).toEqual({ kind: "feat", scope: "net", subject: "add flow logs" });
    expect(classifyCommit("fix: tag subnets")).toEqual({ kind: "fix", subject: "tag subnets" });
    expect(classifyCommit("refactor!: rename inputs")).toEqual({ kind: "breaking", subject: "rename inputs" });
    expect(classifyCommit("docs: readme\n\nBREAKING CHANGE: moved")).toEqual({ kind: "breaking", subject: "readme" });
    expect(classifyCommit("chore(deps): bump")).toEqual({ kind: "other", scope: "deps", subject: "bump" });
  });

  test("keeps a subject that is not conventional whole", () => {
    expect(classifyCommit("Merge pull request #12 from acme/x")).toEqual({ kind: "other", subject: "Merge pull request #12 from acme/x" });
    expect(classifyCommit("Big rework\n\nBREAKING CHANGE: all of it")).toEqual({ kind: "breaking", subject: "Big rework" });
  });
});

describe("releaseChangelog", () => {
  const log = releaseChangelog([
    { sha: "a1", message: "feat(net): add flow logs" },
    { sha: "b2", message: "fix: tag subnets" },
    { sha: "c3", message: "feat!: drop ipv4 default" },
    { sha: "d4", message: "chore: tidy" },
    { sha: "e5", message: "fix(iam): narrow policy" },
  ]);

  test("groups breaking, feat, fix and other, each in the order given", () => {
    expect(log.bump).toBe("major");
    expect(log.groups.breaking.map((e) => e.sha)).toEqual(["c3"]);
    expect(log.groups.feat.map((e) => e.sha)).toEqual(["a1"]);
    expect(log.groups.fix.map((e) => [e.sha, e.scope ?? null])).toEqual([["b2", null], ["e5", "iam"]]);
    expect(log.groups.other.map((e) => e.subject)).toEqual(["tidy"]);
    expect(log.entries.map((e) => e.sha)).toEqual(["a1", "b2", "c3", "d4", "e5"]);
  });

  test("its entries and bump feed the release catalog", () => {
    const catalog = buildReleaseCatalog(
      {
        releases: [{ version: 1, component: "vpc/aws", env: "registry", digest: "sha256:v2", releaseVersion: "2.0.0", gitSha: "f".repeat(40), runId: "r", timestamp: "2026-10-01T00:00:00.000Z", actor: "ci" }],
        changelogs: [{ component: "vpc/aws", version: "2.0.0", bump: log.bump, entries: log.entries }],
      },
      { generatedAt: "2026-10-27T00:00:00.000Z" },
    );
    expect(catalog.components[0].versions[0].changelog).toEqual({ bump: "major", entries: log.entries });
  });
});
