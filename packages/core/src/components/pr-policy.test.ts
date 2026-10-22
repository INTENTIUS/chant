/**
 * `ci.policy` on the pull-request path (#4294): the settings and the policy
 * read at base, the engine run over the change set, and a denial decided
 * against the override ledger. The engine is a fake that prints opa's
 * result shape; nothing reaches a network.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDeclaration, WorkspaceReadError } from "../workspace/declaration";
import { composeChangeSet } from "../change-set";
import { memoryGateLedgerPort } from "../op/gate";
import { overrideDigest } from "../override-gate";
import type { GatePolicyExec } from "../gate-policy";
import { decidePrPolicyOverride, prLoopPolicyAt, prPolicyReport, runPrPolicy, spendPrPolicyOverride, type PrPolicyInput } from "./pr-policy";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "pr-policy-")));
  scratch.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const declaration = (policy: unknown) => ({
  name: "acme",
  schema: 1,
  members: [{ name: "infra", dir: "infra", kind: "other", because: "test" }],
  ...(policy ? { ci: { policy } } : {}),
});

/** A repo whose base declares `ci.policy` with an opa policy and one overrider. */
function repoWithPolicy(): { repo: string; base: string } {
  const repo = tmp();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  mkdirSync(join(repo, "infra"));
  mkdirSync(join(repo, "policy"));
  mkdirSync(join(repo, ".chant"));
  writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ engine: "opa", path: "policy" })));
  writeFileSync(join(repo, "policy", "main.rego"), "package main\n# base\n");
  writeFileSync(join(repo, ".chant", "overriders"), "github:carol\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

const doc = composeChangeSet([]);
const input = (base: string): PrPolicyInput => ({ version: 1, stage: "apply", op: "pr-7", gate: "pr-apply", env: "prod", pr: 7, base, head: "h".repeat(40), changeSet: doc });
const opaOut = (value: unknown): string => JSON.stringify({ result: [{ expressions: [{ value }] }] });

describe("ci.policy in the declaration (#4294)", () => {
  test("parses at the top level, and refuses an unattended outcome", () => {
    const read = (policy: unknown) => parseDeclaration(JSON.stringify(declaration(policy)), "chant.workspace.json", "0.124.41");
    expect(read({ engine: "opa", path: "rules" }).ci?.policy).toEqual({ engine: "opa", path: "rules" });
    expect(() => read({ outcomes: ["allow_unattended"] })).toThrow(WorkspaceReadError);
    expect(() => read({ engine: "rego" })).toThrow(/conftest or opa/);
  });
});

describe("prLoopPolicyAt and runPrPolicy (#4294)", () => {
  test("the settings and the policy come from the base: the change's edits to either do not run", () => {
    const { repo, base } = repoWithPolicy();
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ engine: "opa", path: "policy", command: ["true", "{input}"] })));
    writeFileSync(join(repo, "policy", "main.rego"), "package main\n# the change loosens it\n");
    const read = prLoopPolicyAt(join(repo, "infra"), base);
    expect(read.settings).toEqual({ engine: "opa", path: "policy" });
    let seen = "";
    let fed: unknown;
    const exec: GatePolicyExec = (argv) => {
      seen = readFileSync(join(argv[argv.indexOf("--data") + 1]!, "main.rego"), "utf-8");
      fed = JSON.parse(readFileSync(argv[argv.indexOf("--input") + 1]!, "utf-8"));
      return { status: 0, stdout: opaOut({ deny: ["public bucket"] }), stderr: "" };
    };
    const verdict = runPrPolicy(read, input(base), exec)!;
    expect(seen).toBe("package main\n# base\n");
    expect(fed).toMatchObject({ op: "pr-7", stage: "apply", changeSet: { digest: doc.digest } });
    expect(prPolicyReport(verdict, base)).toEqual({ result: "denied", engine: "opa", base, denials: [{ rule: "main.deny", message: "public bucket" }], rules: ["main.deny"], holds: [], warnings: [] });
  });

  test("no policy at base runs none, and says so when the change declares one", () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "README"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    expect(prLoopPolicyAt(repo, base)).toEqual({ base });
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ engine: "opa" })));
    const read = prLoopPolicyAt(repo, base);
    expect(read.settings).toBeUndefined();
    expect(read.note).toMatch(/runs once it merges/);
    expect(runPrPolicy(read, input(base))).toBeUndefined();
  });

  test("a policy directory the base lacks is an error, which stops the apply", () => {
    const { repo, base } = repoWithPolicy();
    const read = { ...prLoopPolicyAt(repo, base), settings: { engine: "opa" as const, path: "missing" } };
    expect(runPrPolicy(read, input(base), () => ({ status: 0, stdout: opaOut({}), stderr: "" }))).toMatchObject({ result: "error", error: "the policy directory missing does not exist at base" });
  });
});

describe("a denial and its override (#4294)", () => {
  test("no override records the denial once; a listed overrider's override counts; spent, it counts no more", async () => {
    const { repo, base } = repoWithPolicy();
    const port = memoryGateLedgerPort();
    const ask = (record: boolean) =>
      decidePrPolicyOverride({ port, subject: "pr-7", digest: doc.digest, rules: ["main.deny"], base, cwd: repo, sealed: false, record, now: "2026-10-22T10:00:00Z" });

    const plan = await ask(false);
    expect(plan).toMatchObject({ status: "none", recorded: false, overriders: ["github:carol"], command: 'chant approve policy-override pr-7 --rule main.deny --reason "<why>"' });
    expect(port.appended).toHaveLength(0);

    expect(await ask(true)).toMatchObject({ status: "none", recorded: true });
    expect(port.appended[0]).toMatchObject({ op: "policy-override", gate: "pr-7", plan: doc.digest, rules: ["main.deny"] });
    // The denial stands, so a second refusal records no other.
    expect(await ask(true)).toMatchObject({ status: "none", recorded: false });

    const od = overrideDigest("pr-7", doc.digest, ["main.deny"]);
    await port.appendResolution!({ op: "policy-override", gate: "pr-7", resolvedBy: "github:dave", timestamp: "2026-10-22T11:00:00Z", planDigest: od, note: "not listed" });
    expect(await ask(true)).toMatchObject({ status: "none", refusals: [expect.stringContaining("github:dave is not listed")] });

    await port.appendResolution!({ op: "policy-override", gate: "pr-7", resolvedBy: "github:carol", timestamp: "2026-10-22T12:00:00Z", planDigest: od, note: "the bucket is the public docs site" });
    const counted = await ask(true);
    expect(counted).toEqual({ status: "overridden", override: { by: "github:carol", at: "2026-10-22T12:00:00Z", reason: "the bucket is the public docs site", digest: od } });

    if (counted.status !== "overridden") throw new Error("expected an override");
    await spendPrPolicyOverride(port, "pr-7", counted.override, { now: "2026-10-22T12:30:00Z", commit: "c".repeat(40) });
    expect(port.applied).toEqual([expect.objectContaining({ op: "policy-override", gate: "pr-7", planDigest: od, approvedBy: "github:carol", commit: "c".repeat(40) })]);
    expect(await ask(true)).toMatchObject({ status: "none", refusals: expect.arrayContaining([expect.stringContaining("is spent")]) });
  });

  test("an applied record that does not reach the remote throws, so nothing applies", async () => {
    const port = { ...memoryGateLedgerPort(), appendApplied: async () => ({ pushed: false, pushWarning: 'the push of chant/lifecycle to "origin" failed' }) };
    await expect(spendPrPolicyOverride(port, "pr-7", { by: "github:carol", at: "2026-10-22T12:00:00Z", reason: "ok", digest: "sha256:1" })).rejects.toThrow(/did not reach the remote/);
  });
});
