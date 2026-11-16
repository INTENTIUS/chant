/**
 * The `release-changed` read (#5134): the members to release at a commit, with
 * the dependency closure, held to `release-changed.schema.json`. Every repo is
 * a temp repo.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { contract } from "./__fixtures__/contract-repo";
import schema from "./release-changed.schema.json";
import { bumpLabel, rangeAdmits, releaseChangedDocument, type ReleaseChangedDocument } from "./release-changed";

const { expectValid } = contract(schema);

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function commit(dir: string, message: string, files: Record<string, string>): string {
  put(dir, files);
  git(dir, "add", ...Object.keys(files));
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

const pkg = (name: string, peers: Record<string, string> = {}) => JSON.stringify({ name, version: "0.0.0", peerDependencies: peers });
const CORE = "@intentius/chant";
const NESTED = ["core", "lexicon-aws", "lexicon-k8s"];

/** An outer workspace holding three packages and a nested `release/` workspace with one member each, tagged as released at 0.124.44. */
function repo(dir: string, ranges = "^0.124.34"): string {
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@chant.dev"], ["config", "user.name", "T"]]) git(dir, ...args);
  const first = commit(dir, "init", {
    "chant.workspace.json": JSON.stringify({
      name: "outer",
      schema: 1,
      changes: { ignore: ["**/*.test.ts"] },
      members: [
        { name: "core", dir: "packages/core", kind: "chant" },
        { name: "lexicon-aws", dir: "lexicons/aws", kind: "chant" },
        { name: "lexicon-k8s", dir: "lexicons/k8s", kind: "chant" },
        { name: "npm", dir: "release", kind: "workspace" },
      ],
    }),
    "release/chant.workspace.json": JSON.stringify({ name: "npm", schema: 1, members: NESTED.map((n) => ({ name: n, dir: n, kind: "chant" })) }),
    "release/chant.config.json": JSON.stringify({ release: { legacyTags: ["release/npm/", "chant-v"] } }),
    ...Object.fromEntries(NESTED.map((n) => [`release/${n}/chant.config.json`, "{}"])),
    "packages/core/package.json": pkg(CORE),
    "packages/core/src/index.ts": "export {};\n",
    "lexicons/aws/package.json": pkg("@intentius/chant-lexicon-aws", { [CORE]: ranges }),
    "lexicons/aws/src/index.ts": "export {};\n",
    "lexicons/k8s/package.json": pkg("@intentius/chant-lexicon-k8s", { [CORE]: ranges }),
    "lexicons/k8s/src/index.ts": "export {};\n",
  });
  git(dir, "tag", "release/npm/0.124.44", first);
  return first;
}

const names = (doc: ReleaseChangedDocument) => ("members" in doc ? doc.members.map((m) => m.member) : doc);

describe("rangeAdmits and bumpLabel", () => {
  test("caret, tilde, x-ranges and unions follow npm", () => {
    expect(rangeAdmits("^0.124.34", "0.124.45")).toBe(true);
    expect(rangeAdmits("^0.124.34", "0.125.0")).toBe(false);
    expect(rangeAdmits("^1.2.3", "1.9.0")).toBe(true);
    expect(rangeAdmits("^1.2.3", "2.0.0")).toBe(false);
    expect(rangeAdmits("^0.0.3", "0.0.4")).toBe(false);
    expect(rangeAdmits("~1.2.3", "1.2.9")).toBe(true);
    expect(rangeAdmits("~1.2.3", "1.3.0")).toBe(false);
    expect(rangeAdmits("1.x", "1.4.0")).toBe(true);
    expect(rangeAdmits(">=1.0.0 <2.0.0", "2.0.0")).toBe(false);
    expect(rangeAdmits("^1.0.0 || ^3.0.0", "3.1.0")).toBe(true);
    expect(rangeAdmits("*", "9.9.9")).toBe(true);
    expect(rangeAdmits("workspace:*", "9.9.9")).toBe(true);
  });
  test("bumps a label", () => {
    expect(bumpLabel("0.124.44", "patch")).toBe("0.124.45");
    expect(bumpLabel("0.124.44", "minor")).toBe("0.125.0");
    expect(bumpLabel("v1.2.3", "major")).toBe("2.0.0");
    expect(bumpLabel("nightly", "patch")).toBeNull();
  });
});

describe("chant release changed (#5134)", () => {
  test("a range touching only lexicons/aws lists lexicon-aws alone", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      const at = commit(dir, "aws", { "lexicons/aws/src/index.ts": "export const a = 1;\n" });
      const doc = await releaseChangedDocument({ cwd: join(dir, "release") });
      expectValid(doc);
      expect(names(doc)).toEqual(["lexicon-aws"]);
      if (!("members" in doc)) throw new Error("no members");
      expect(doc.at).toBe(at);
      expect(doc.members[0]).toMatchObject({ layer: 0, reason: { code: "paths-changed", member: null }, next: "0.124.45", bump: "patch", paths: ["lexicons/aws/src/index.ts"] });
      expect(doc.members[0].last).toMatchObject({ label: "0.124.44", source: "legacy" });
    });
  });

  test("core is listed, first, when it has changes of its own", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      commit(dir, "both", { "lexicons/aws/src/index.ts": "export const a = 1;\n", "packages/core/src/index.ts": "export const c = 1;\n" });
      const doc = await releaseChangedDocument({ cwd: join(dir, "release") });
      expectValid(doc);
      if (!("members" in doc)) throw new Error("no members");
      expect(doc.members.map((m) => [m.member, m.layer, m.reason.code, m.reason.member])).toEqual([
        ["core", 0, "needed-by", "lexicon-aws"],
        ["lexicon-aws", 1, "paths-changed", null],
      ]);
    });
  });

  test("test-only, ignored and generated paths list nothing", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      commit(dir, "tests", { "packages/core/src/index.test.ts": "export {};\n", "release/core/notes.md": "x\n" });
      const doc = await releaseChangedDocument({ cwd: join(dir, "release") });
      expectValid(doc);
      expect(names(doc)).toEqual([]);
    });
  });

  test("a core minor bump lists every member whose peer range excludes the new label", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      commit(dir, "core", { "packages/core/src/index.ts": "export const c = 1;\n" });
      const patch = await releaseChangedDocument({ cwd: join(dir, "release") });
      expect(names(patch)).toEqual(["core"]);
      const minor = await releaseChangedDocument({ cwd: join(dir, "release"), bump: ["core=minor"] });
      expectValid(minor);
      if (!("members" in minor)) throw new Error("no members");
      expect(minor.members.map((m) => [m.member, m.layer, m.reason.code, m.reason.member, m.next])).toEqual([
        ["core", 0, "paths-changed", null, "0.125.0"],
        ["lexicon-aws", 1, "range-broken-by", "core", "0.124.45"],
        ["lexicon-k8s", 1, "range-broken-by", "core", "0.124.45"],
      ]);
    });
  });

  test("--at reads an earlier commit, and member tags are not legacy tags", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      const first = commit(dir, "aws", { "lexicons/aws/src/index.ts": "export const a = 1;\n" });
      git(dir, "tag", "release/npm/core/0.125.0", first);
      commit(dir, "k8s", { "lexicons/k8s/src/index.ts": "export const k = 1;\n" });
      expect(names(await releaseChangedDocument({ cwd: join(dir, "release"), at: first }))).toEqual(["lexicon-aws"]);
      expect(names(await releaseChangedDocument({ cwd: join(dir, "release") }))).toEqual(["lexicon-aws", "lexicon-k8s"]);
    });
  });

  test("#5159: the bump comes from the commits over the member's paths and the pending intent files; --bump-member sets it outright", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      commit(dir, "feat(core): read the config once", { "packages/core/src/index.ts": "export const c = 1;\n" });
      commit(dir, "fix: an aws fix", { "lexicons/aws/src/index.ts": "export const a = 1;\n" });
      commit(dir, "chore: plan", { ".chant/release/k8s.md": "---\nlexicon-k8s: patch\n---\nk8s kinds refreshed.\n" });
      const doc = await releaseChangedDocument({ cwd: join(dir, "release") });
      expectValid(doc);
      if (!("members" in doc)) throw new Error(JSON.stringify(doc));
      expect(doc.members.map((m) => [m.member, m.reason.code, m.reason.member, m.bump, m.bumpFrom, m.next, m.intents])).toEqual([
        ["core", "needed-by", "lexicon-aws", "minor", "commits", "0.125.0", []],
        ["lexicon-aws", "paths-changed", null, "patch", "commits", "0.124.45", []],
        ["lexicon-k8s", "intent-pending", null, "patch", "intents", "0.124.45", [".chant/release/k8s.md"]],
      ]);
      const flagged = await releaseChangedDocument({ cwd: join(dir, "release"), bump: ["core=patch"] });
      if (!("members" in flagged)) throw new Error("no members");
      expect(flagged.members.find((m) => m.member === "core")).toMatchObject({ bump: "patch", bumpFrom: "flag", next: "0.124.45" });

      commit(dir, "chore: a typo", { ".chant/release/typo.md": "---\nlexicon-gcp: minor\n---\n" });
      const bad = await releaseChangedDocument({ cwd: join(dir, "release") });
      expectValid(bad);
      expect("error" in bad && bad.error.code).toBe("intent-invalid");
    });
  });

  test("errors are coded", async () => {
    await withTestDir(async (dir) => {
      repo(dir);
      const code = async (q: Partial<Parameters<typeof releaseChangedDocument>[0]>) => {
        const doc = await releaseChangedDocument({ cwd: join(dir, "release"), ...q });
        expectValid(doc);
        return "error" in doc ? doc.error.code : null;
      };
      expect(await code({ at: "nope" })).toBe("revision-unknown");
      expect(await code({ bump: ["core=huge"] })).toBe("bump-invalid");
      expect(await code({ bump: ["ghost=minor"] })).toBe("bump-invalid");
    });
    await withTestDir(async (dir) => {
      const doc = await releaseChangedDocument({ cwd: dir });
      expect("error" in doc && doc.error.code).toBe("not-a-git-repository");
    });
  });
});
