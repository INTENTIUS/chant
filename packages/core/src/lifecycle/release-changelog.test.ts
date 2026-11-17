/**
 * The changelog from conventional commits (#4597): grouping, scopes, and a
 * bump that agrees with terragucci's `bumpFor` on its own cases
 * (terragucci `test/publish.test.ts`).
 */
import { describe, expect, test } from "vitest";
import { classifyCommit, changelogBump, changelogNotes, notesListCommit, releaseChangelog } from "./release-changelog";
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
    expect(classifyCommit("feat(net): add flow logs\n\nbody")).toEqual({ kind: "feat", type: "feat", scope: "net", subject: "add flow logs" });
    expect(classifyCommit("fix: tag subnets")).toEqual({ kind: "fix", type: "fix", subject: "tag subnets" });
    expect(classifyCommit("refactor!: rename inputs")).toEqual({ kind: "breaking", type: "refactor", subject: "rename inputs" });
    expect(classifyCommit("docs: readme\n\nBREAKING CHANGE: moved")).toEqual({ kind: "breaking", type: "docs", subject: "readme" });
    expect(classifyCommit("chore(deps): bump")).toEqual({ kind: "other", type: "chore", scope: "deps", subject: "bump" });
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

describe("changelogNotes (#5153)", () => {
  const commits = [
    { sha: "a1".padEnd(40, "0"), message: "feat(net): add flow logs" },
    { sha: "b2".padEnd(40, "0"), message: "fix: tag subnets" },
    { sha: "c3".padEnd(40, "0"), message: "refactor!: rename inputs" },
    { sha: "d4".padEnd(40, "0"), message: "chore: tidy" },
    { sha: "e5".padEnd(40, "0"), message: "perf(iam): cache policies" },
    { sha: "f6".padEnd(40, "0"), message: "Update README" },
  ];

  test("lists feat, fix and perf by default, and a breaking change of any type, grouped with a short sha", () => {
    expect(changelogNotes(commits)).toBe(
      [
        "### Breaking changes",
        "",
        "- rename inputs (c300000)",
        "",
        "### Features",
        "",
        "- net: add flow logs (a100000)",
        "",
        "### Fixes",
        "",
        "- tag subnets (b200000)",
        "",
        "### Other changes",
        "",
        "- iam: cache policies (e500000)",
      ].join("\n"),
    );
  });

  test("types narrows the list, * lists every commit, and nothing listed is empty", () => {
    expect(changelogNotes(commits, ["fix"])).toBe(["### Breaking changes", "", "- rename inputs (c300000)", "", "### Fixes", "", "- tag subnets (b200000)"].join("\n"));
    expect(changelogNotes(commits, ["*"]).split("\n").filter((l) => l.startsWith("- "))).toHaveLength(6);
    expect(changelogNotes([commits[3]!], ["feat"])).toBe("");
  });

  const listed = (notes: string) => notes.split("\n").filter((l) => l.startsWith("- "));

  test("exclude lists every commit but those types, conventional or not (#5270)", () => {
    const notes = changelogNotes(commits, { exclude: ["chore", "docs", "test"] });
    expect(listed(notes)).toEqual(["- rename inputs (c300000)", "- net: add flow logs (a100000)", "- tag subnets (b200000)", "- iam: cache policies (e500000)", "- Update README (f600000)"]);
    // A breaking change is listed even when its type is excluded.
    expect(notesListCommit("chore!: drop node 18", { exclude: ["chore"] })).toBe(true);
    expect(notesListCommit("chore(deps): bump", { exclude: ["chore"] })).toBe(false);
  });

  test("nonConventional decides the commits that are not conventional either way (#5270)", () => {
    expect(listed(changelogNotes(commits, { exclude: ["chore"], nonConventional: false }))).not.toContain("- Update README (f600000)");
    expect(listed(changelogNotes(commits, { types: ["fix"], nonConventional: true }))).toEqual(["- rename inputs (c300000)", "- tag subnets (b200000)", "- Update README (f600000)"]);
    expect(listed(changelogNotes(commits, { types: ["*"], nonConventional: false }))).toHaveLength(5);
    // The default list of types leaves them out, as it always did.
    expect(notesListCommit("Update README")).toBe(false);
  });
});
