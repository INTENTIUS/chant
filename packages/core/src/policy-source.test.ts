/**
 * `ci.policy.source` and policy packs read at base (#4613). The shared
 * policy repository is a local bare repository reached through file://, so
 * nothing reaches a network. The engine is a fake that reads the policy
 * directory it is handed and prints opa's result shape, so a test sees which
 * copy of a rule judged the change.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composeChangeSet } from "./change-set";
import { assertGatePolicySettings, type GatePolicyExec } from "./gate-policy";
import { assertGatePolicySource, fetchGatePolicySource, shownPolicyRepo } from "./policy-source";
import { policyPacksAtBase } from "./policy-packs";
import { prLoopPolicyAt, prPolicyReport, runPrPolicy, type PrPolicyInput } from "./components/pr-policy";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "policy-source-")));
  scratch.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const ident = (repo: string): void => {
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
};

/** A bare policy repository with tag v1 (`deny_bucket_delete`), then main moved on to v2 (no rule). */
function policyRepo(): { bare: string; url: string; v1: string; v2: string } {
  const work = tmp();
  git(work, "init", "-q", "-b", "main");
  ident(work);
  mkdirSync(join(work, "rego"));
  mkdirSync(join(work, "packs", "aws-guard"), { recursive: true });
  writeFileSync(join(work, "rego", "main.rego"), "package main\n# deny_bucket_delete\n");
  writeFileSync(join(work, "packs", "aws-guard", "index.ts"), "// shared no-public-bucket v1\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "v1");
  git(work, "tag", "v1");
  const v1 = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "rego", "main.rego"), "package main\n# nothing\n");
  git(work, "commit", "-q", "-am", "v2");
  const v2 = git(work, "rev-parse", "HEAD");
  const bare = join(tmp(), "policy.git");
  git(work, "clone", "-q", "--bare", work, bare);
  return { bare, url: `file://${bare}`, v1, v2 };
}

const declaration = (policy: unknown) => ({
  name: "acme",
  schema: 1,
  members: [{ name: "infra", dir: "infra", kind: "other", because: "test" }],
  ci: { policy },
});

/** A workspace repo whose base declares `policy`, and whose head commit rewrites it to `headPolicy`. */
function workspace(policy: unknown, files: Record<string, string> = {}, headPolicy?: unknown, headFiles: Record<string, string> = {}): { repo: string; base: string } {
  const repo = tmp();
  git(repo, "init", "-q", "-b", "main");
  ident(repo);
  mkdirSync(join(repo, "infra"), { recursive: true });
  writeFileSync(join(repo, "infra", "Pulumi.yaml"), "name: infra\nruntime: nodejs\n");
  writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration(policy)));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  if (headPolicy !== undefined) writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration(headPolicy)));
  for (const [p, text] of Object.entries(headFiles)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
  if (headPolicy !== undefined || Object.keys(headFiles).length > 0) {
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "head");
  }
  return { repo, base };
}

const input = (base: string): PrPolicyInput => ({ version: 1, stage: "apply", op: "pr-7", gate: "pr-apply", env: "prod", pr: 7, base, head: "h".repeat(40), changeSet: composeChangeSet([]) });

/** An opa stand-in: the rules it finds named in the policy directory's main.rego match. */
const readsRego: GatePolicyExec = (argv) => {
  const dir = argv[argv.indexOf("--data") + 1]!;
  const text = readFileSync(join(dir, "main.rego"), "utf-8");
  const value: Record<string, unknown> = {};
  if (text.includes("deny_bucket_delete")) value.deny_bucket_delete = ["the bucket is deleted"];
  return { status: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value }] }] }), stderr: "" };
};

describe("the settings (#4613)", () => {
  test("a source is { repo, ref, path? } and refuses anything else", () => {
    expect(() => assertGatePolicySource("s", { repo: "https://git.example.com/org/policy.git", ref: "v1" })).not.toThrow();
    expect(() => assertGatePolicySource("s", { repo: "git@git.example.com:org/policy.git", ref: "main", path: "rego" })).not.toThrow();
    expect(() => assertGatePolicySource("s", { repo: "file:///srv/policy.git", ref: "0123456789abcdef0123456789abcdef01234567" })).not.toThrow();
    expect(() => assertGatePolicySource("s", { repo: "--upload-pack=x", ref: "v1" })).toThrow(/git URL/);
    expect(() => assertGatePolicySource("s", { repo: "https://git.example.com/p.git", ref: "-x" })).toThrow(/tag, a branch or a commit/);
    expect(() => assertGatePolicySource("s", { repo: "https://git.example.com/p.git", ref: "a..b" })).toThrow(/tag, a branch or a commit/);
    expect(() => assertGatePolicySource("s", { repo: "https://git.example.com/p.git", ref: "v1", path: "../x" })).toThrow(/inside the source/);
    expect(() => assertGatePolicySource("s", { repo: "https://git.example.com/p.git", ref: "v1", branch: "x" })).toThrow(/not a setting/);
  });

  test("ci.policy takes source and packs, and refuses path beside source", () => {
    const source = { repo: "https://git.example.com/p.git", ref: "v1" };
    expect(() => assertGatePolicySettings("ci.policy", { engine: "opa", source })).not.toThrow();
    expect(() => assertGatePolicySettings("ci.policy", { packs: [{ dir: "packs/aws-guard", config: "packs/aws-guard.json" }] })).not.toThrow();
    expect(() => assertGatePolicySettings("ci.policy", { path: "policy", source })).toThrow(/cannot both be set/);
    expect(() => assertGatePolicySettings("ci.policy", { packs: [] })).toThrow(/non-empty list/);
    expect(() => assertGatePolicySettings("ci.policy", { packs: [{ dir: "/abs" }] })).toThrow(/inside the workspace/);
    expect(() => assertGatePolicySettings("ci.policy", { packs: [{ config: "x.json" }] })).toThrow(/dir is required/);
  });

  test("a repository's user and password stay out of what is shown", () => {
    expect(shownPolicyRepo("https://bot:s3cret@git.example.com/org/policy.git")).toBe("https://git.example.com/org/policy.git");
  });
});

describe("fetching the source over a local bare repository", () => {
  test("a tag, a branch and a commit each give the commit they name", () => {
    const p = policyRepo();
    const tag = fetchGatePolicySource({ repo: p.url, ref: "v1", path: "rego" });
    const branch = fetchGatePolicySource({ repo: p.url, ref: "main", path: "rego" });
    const commit = fetchGatePolicySource({ repo: p.url, ref: p.v1, path: "rego" });
    for (const f of [tag, branch, commit]) if ("error" in f) throw new Error(f.error);
    if ("error" in tag || "error" in branch || "error" in commit) return;
    expect(tag.source).toEqual({ repo: p.url, ref: "v1", commit: p.v1, path: "rego" });
    expect(branch.source.commit).toBe(p.v2);
    expect(commit.source.commit).toBe(p.v1);
    expect(tag.tree.read("rego/main.rego")).toContain("deny_bucket_delete");
    for (const f of [tag, branch, commit]) f.cleanup();
  });

  test("a ref the repository lacks, or a repository that is not there, is an error naming the source", () => {
    const p = policyRepo();
    const missing = fetchGatePolicySource({ repo: p.url, ref: "v9" });
    expect("error" in missing && missing.error).toMatch(/v9 is not a tag, branch or commit there/);
    const gone = fetchGatePolicySource({ repo: `file://${join(tmp(), "nothing.git")}`, ref: "v1" });
    expect("error" in gone && gone.error).toMatch(/^ci\.policy\.source: could not read/);
  });
});

describe("the Rego of a source judges the change (#4613)", () => {
  test("the source's rule at its ref judges, and the report names the commit", () => {
    const p = policyRepo();
    const ws = workspace({ engine: "opa", source: { repo: p.url, ref: "v1", path: "rego" } });
    const read = prLoopPolicyAt(join(ws.repo, "infra"), ws.base);
    expect(read.source).toEqual({ repo: p.url, ref: "v1", commit: p.v1, path: "rego" });
    const verdict = runPrPolicy(read, input(ws.base), readsRego)!;
    expect(verdict.result).toBe("denied");
    expect(verdict.rules).toEqual(["main.deny_bucket_delete"]);
    expect(prPolicyReport(verdict, ws.base).source).toEqual({ repo: p.url, ref: "v1", commit: p.v1, path: "rego" });
  });

  test("a head that repoints the source at a looser ref is still judged by the base's", () => {
    const p = policyRepo();
    const ws = workspace({ engine: "opa", source: { repo: p.url, ref: "v1", path: "rego" } }, {}, { engine: "opa", source: { repo: p.url, ref: "main", path: "rego" } });
    const read = prLoopPolicyAt(join(ws.repo, "infra"), ws.base);
    expect(read.source?.commit).toBe(p.v1);
    expect(runPrPolicy(read, input(ws.base), readsRego)!.result).toBe("denied");
  });

  test("a workspace rule changed on the head is judged by the base rule", () => {
    const ws = workspace({ engine: "opa", path: "policy" }, { "policy/main.rego": "package main\n# deny_bucket_delete\n" }, undefined, { "policy/main.rego": "package main\n# loosened\n" });
    const read = prLoopPolicyAt(join(ws.repo, "infra"), ws.base);
    expect(read.source).toBeUndefined();
    const verdict = runPrPolicy(read, input(ws.base), readsRego)!;
    expect(verdict.result).toBe("denied");
    expect(verdict.source).toBeUndefined();
  });

  test("a source that cannot be fetched is an error verdict, so nothing applies", () => {
    const ws = workspace({ engine: "opa", source: { repo: `file://${join(tmp(), "nothing.git")}`, ref: "v1" } });
    const read = prLoopPolicyAt(join(ws.repo, "infra"), ws.base);
    expect(read.error).toMatch(/could not read/);
    expect(runPrPolicy(read, input(ws.base), readsRego)!.result).toBe("error");
  });

  test("a source with no Rego directory at the ref is an error", () => {
    const p = policyRepo();
    const ws = workspace({ engine: "opa", source: { repo: p.url, ref: "v1", path: "missing" } });
    const verdict = runPrPolicy(prLoopPolicyAt(join(ws.repo, "infra"), ws.base), input(ws.base), readsRego)!;
    expect(verdict.result).toBe("error");
    expect(verdict.error).toMatch(/missing does not exist in .*@v1/);
  });

  test("ci.policy with only packs runs no Rego when there is no policy directory", () => {
    const ws = workspace({ packs: [{ dir: "packs/aws-guard" }] }, { "packs/aws-guard/index.ts": "// v1\n" });
    expect(runPrPolicy(prLoopPolicyAt(join(ws.repo, "infra"), ws.base), input(ws.base), readsRego)).toBeUndefined();
  });
});

describe("CrossGuard packs read at base (#4613)", () => {
  test("a step pack changed on the head runs as the base has it, with a note", async () => {
    const ws = workspace({ engine: "opa" }, { "infra/guard/index.ts": "// mandatory no-public-bucket\n", "infra/guard.json": '{"no-public-bucket":"mandatory"}' }, undefined, {
      "infra/guard/index.ts": "// advisory no-public-bucket\n",
      "infra/guard.json": '{"no-public-bucket":"advisory"}',
    });
    const got = await policyPacksAtBase({ cwd: join(ws.repo, "infra"), base: ws.base, stepPacks: [{ dir: "guard", config: "guard.json" }], tmp: tmp() });
    if ("error" in got) throw new Error(got.error);
    expect(got.packs).toHaveLength(1);
    expect(readFileSync(join(got.packs[0]!.dir, "index.ts"), "utf-8")).toContain("mandatory");
    expect(readFileSync(got.packs[0]!.config!, "utf-8")).toContain("mandatory");
    expect(got.notes.join("\n")).toMatch(/guard differs on this change/);
    expect(got.notes.join("\n")).toMatch(/guard\.json differs on this change/);
    got.cleanup();
    expect(existsSync(got.scratch)).toBe(false);
  });

  test("a step pack the base does not have runs once the change merges", async () => {
    const ws = workspace({ engine: "opa" }, {}, undefined, { "infra/new-guard/index.ts": "// new\n" });
    const got = await policyPacksAtBase({ cwd: join(ws.repo, "infra"), base: ws.base, stepPacks: [{ dir: "new-guard" }], tmp: tmp() });
    if ("error" in got) throw new Error(got.error);
    expect(got.packs).toEqual([]);
    expect(got.notes).toEqual([expect.stringMatching(/new-guard is not at base .*runs once this change merges/)]);
  });

  test("a pack outside the repository is used where it stands", async () => {
    const outside = tmp();
    const ws = workspace({ engine: "opa" });
    const got = await policyPacksAtBase({ cwd: join(ws.repo, "infra"), base: ws.base, stepPacks: [{ dir: outside }], tmp: tmp() });
    if ("error" in got) throw new Error(got.error);
    expect(got.packs).toEqual([{ dir: outside, from: "step", name: outside }]);
  });

  test("ci.policy.packs at base runs even when the head drops it from the declaration", async () => {
    const ws = workspace({ packs: [{ dir: "packs/aws-guard" }] }, { "packs/aws-guard/index.ts": "// base pack\n" }, { engine: "opa" }, { "packs/aws-guard/index.ts": "// head pack\n" });
    const got = await policyPacksAtBase({ cwd: join(ws.repo, "infra"), base: ws.base, tmp: tmp() });
    if ("error" in got) throw new Error(got.error);
    expect(got.packs.map((p) => [p.from, p.name])).toEqual([["declaration", "packs/aws-guard"]]);
    expect(readFileSync(join(got.packs[0]!.dir, "index.ts"), "utf-8")).toContain("base pack");
  });

  test("ci.policy.packs comes from the source when one is set, at the ref the base names", async () => {
    const p = policyRepo();
    const ws = workspace({ source: { repo: p.url, ref: "v1", path: "rego" }, packs: [{ dir: "packs/aws-guard" }] });
    const got = await policyPacksAtBase({ cwd: join(ws.repo, "infra"), base: ws.base, tmp: tmp() });
    if ("error" in got) throw new Error(got.error);
    expect(got.source?.commit).toBe(p.v1);
    expect(readFileSync(join(got.packs[0]!.dir, "index.ts"), "utf-8")).toContain("shared no-public-bucket v1");
  });

  test("a pack ci.policy.packs lists that is not there is an error, so the preview does not run", async () => {
    const ws = workspace({ packs: [{ dir: "packs/gone" }] });
    const got = await policyPacksAtBase({ cwd: join(ws.repo, "infra"), base: ws.base, tmp: tmp() });
    expect("error" in got && got.error).toMatch(/packs\/gone, which is not a directory/);
  });
});
