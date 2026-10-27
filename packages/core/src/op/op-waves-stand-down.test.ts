/**
 * Stand-down for op waves (#4581): an apply whose targets a newer commit on
 * the branch also applies stands down, exit 6, with a run record saying so.
 * The repositories are real and local: a bare `origin` and a clone at the
 * older of two commits, so the branch's tip on origin is the newer one.
 */

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { assertOpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveRunPort, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CHANT_EXIT } from "../exit-codes";
import { CapabilityRegistry, type Capability } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import type { OpRunRecordInput } from "./runtime";
import { newerCommitOnBranch, opWaveStandDownReason, tipAppliesTargets } from "./op-waves-stand-down";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A bare origin with two commits on main, each writing `waves.json`
 * (`older` then `newer`, the second defaulting to the first), and a clone
 * checked out at the first. Returns the clone and both shas.
 */
function twoCommits(older: OpWavesSpec, newer: OpWavesSpec = older): { cwd: string; first: string; second: string } {
  const root = mkdtempSync(join(tmpdir(), "op-waves-stand-down-"));
  const origin = join(root, "origin.git");
  const writer = join(root, "writer");
  const cwd = join(root, "job");
  git(root, "init", "--bare", "--quiet", origin);
  git(root, "clone", "--quiet", origin, writer);
  writeFileSync(join(writer, "waves.json"), JSON.stringify(older));
  git(writer, "add", "waves.json");
  git(writer, "commit", "--quiet", "-m", "first");
  git(writer, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const first = git(writer, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--branch", "main", origin, cwd);
  writeFileSync(join(writer, "waves.json"), JSON.stringify({ ...newer, labels: { Commit: "second" } }));
  git(writer, "commit", "--quiet", "-am", "second");
  git(writer, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const second = git(writer, "rev-parse", "HEAD");
  return { cwd, first, second };
}

const part = (member: string): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
  entries: [{ member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action: "create" } as ChangeSetPart["entries"][number]],
});

function fakeCapability(): { registry: CapabilityRegistry; ran: string[] } {
  const ran: string[] = [];
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(_ctx, input) {
      const root = String(input.root);
      return { member: root, planDigest: digest(root === "network" ? "1" : "2"), artifact: { planFile: `${root}.tfplan` }, changeSet: part(root) };
    },
    async run(_ctx, input) {
      ran.push(String(input.root));
      return { applied: input.root };
    },
  };
  return { registry: new CapabilityRegistry().register(cap), ran };
}

function recordPort(): { port: OpWaveRunPort; records: OpRunRecordInput[] } {
  const records: OpRunRecordInput[] = [];
  return { records, port: { append: async (r) => void records.push(r) } };
}

const spec: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  standDown: true,
  step: { kind: "fake-apply", root: "{target}" },
  waves: [{ name: "dev", runs: [{ target: "network" }, { target: "app" }], gate: "never" }],
};

/** The base rules read `text` at `HEAD^1`; any other ref (the tip) is read through git itself. */
function baseOnly(text: string): OpWaveShowAtBase {
  return (ref, path, cwd) => {
    if (ref === "HEAD^1") return { sha: "b".repeat(40), text };
    try {
      return { sha: ref, text: execFileSync("git", ["show", `${ref}:${path}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }) };
    } catch {
      return { sha: ref, text: null };
    }
  };
}

const env = { GITHUB_REF_NAME: "main" } as NodeJS.ProcessEnv;

describe("newerCommitOnBranch (#4581)", () => {
  test("a clone at the older of two commits finds the newer one on origin", async () => {
    const { cwd, first, second } = twoCommits(spec);
    git(cwd, "checkout", "--quiet", first);
    expect(await newerCommitOnBranch(cwd, env)).toEqual({ branch: "main", head: first, tip: second });
  });

  test("at the tip, with no branch, or with a tip that does not contain the commit, there is none", async () => {
    const { cwd, first, second } = twoCommits(spec);
    expect(await newerCommitOnBranch(cwd, env, second)).toBeUndefined();
    git(cwd, "checkout", "--quiet", first);
    expect(await newerCommitOnBranch(cwd, {} as NodeJS.ProcessEnv)).toBeUndefined();
    // A commit beside the tip, as after a force-push: not newer.
    writeFileSync(join(cwd, "other.txt"), "x");
    git(cwd, "add", "other.txt");
    git(cwd, "commit", "--quiet", "-m", "beside");
    expect(await newerCommitOnBranch(cwd, env)).toBeUndefined();
  });
});

describe("an op wave stands down for a newer commit (#4581)", () => {
  test("a newer commit whose wave applies the same targets: nothing applies, exit 6, and the run record says so", async () => {
    const { cwd, first, second } = twoCommits(spec);
    git(cwd, "checkout", "--quiet", first);
    const { registry, ran } = fakeCapability();
    const { port, records } = recordPort();
    const logs: string[] = [];
    const result = await runOpWave({
      spec,
      specFile: "waves.json",
      wave: 1,
      cwd,
      head: first,
      show: baseOnly(JSON.stringify(spec)),
      gates: memoryGateLedgerPort(),
      capabilities: registry,
      runs: port,
      newerCommit: (dir, head) => newerCommitOnBranch(dir, env, head),
      log: (l) => logs.push(l),
    });
    expect(result.exitCode).toBe(CHANT_EXIT.superseded);
    expect(result.applied).toEqual([]);
    expect(ran).toEqual([]);
    expect(result.outcome).toMatchObject({ outcome: "stood-down" });
    expect(result.supersededBy).toEqual({ branch: "main", commit: second });
    expect(logs.some((l) => l.includes("standing down, nothing applied") && l.includes(second.slice(0, 12)))).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "ok", wave: { exitCode: CHANT_EXIT.superseded, outcome: "stood-down", supersededBy: { branch: "main", commit: second }, applied: [] } });
  });

  test("a newer commit whose wave drops a target leaves this job to apply", async () => {
    const dropped: OpWavesSpec = { ...spec, waves: [{ name: "dev", runs: [{ target: "network" }], gate: "never" }] };
    const { cwd, first, second } = twoCommits(spec, dropped);
    git(cwd, "checkout", "--quiet", first);
    const { registry, ran } = fakeCapability();
    const result = await runOpWave({
      spec,
      specFile: "waves.json",
      wave: 1,
      cwd,
      head: first,
      show: baseOnly(JSON.stringify(spec)),
      gates: memoryGateLedgerPort(),
      capabilities: registry,
      runs: recordPort().port,
      newerCommit: (dir, head) => newerCommitOnBranch(dir, env, head),
    });
    expect(result.exitCode).toBe(0);
    expect(ran).toEqual(["network", "app"]);
    expect(result.supersededBy).toBeUndefined();
  });

  test("without standDown, a newer commit changes nothing", async () => {
    const off: OpWavesSpec = { ...spec, standDown: false };
    const { cwd, first, second } = twoCommits(off);
    git(cwd, "checkout", "--quiet", first);
    const { registry, ran } = fakeCapability();
    let asked = false;
    const result = await runOpWave({
      spec: off,
      specFile: "waves.json",
      wave: 1,
      cwd,
      head: first,
      show: baseOnly(JSON.stringify(off)),
      gates: memoryGateLedgerPort(),
      capabilities: registry,
      runs: recordPort().port,
      newerCommit: async () => {
        asked = true;
        return { branch: "main", head: first, tip: second };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(ran).toEqual(["network", "app"]);
    expect(asked).toBe(false);
  });

  test("at the tip itself the job applies", async () => {
    const { cwd, second } = twoCommits(spec);
    const { registry, ran } = fakeCapability();
    const result = await runOpWave({
      spec,
      specFile: "waves.json",
      wave: 1,
      cwd,
      head: second,
      show: baseOnly(JSON.stringify(spec)),
      gates: memoryGateLedgerPort(),
      capabilities: registry,
      runs: recordPort().port,
      newerCommit: (dir, head) => newerCommitOnBranch(dir, env, head),
    });
    expect(result.exitCode).toBe(0);
    expect(ran).toEqual(["network", "app"]);
  });
});

describe("the standDown setting (#4581)", () => {
  test("must be a boolean", () => {
    expect(() => assertOpWavesSpec({ ...spec, standDown: "yes" as unknown as boolean })).toThrow(/standDown/);
    expect(() => assertOpWavesSpec(spec)).not.toThrow();
  });

  test("a tip's spec covers the targets only on the branch, in a wave of the same name listing each", () => {
    expect(tipAppliesTargets(spec, "main", "dev", ["network", "app"])).toBe(true);
    expect(tipAppliesTargets(spec, "release", "dev", ["network"])).toBe(false);
    expect(tipAppliesTargets(spec, "main", "prod", ["network"])).toBe(false);
    expect(tipAppliesTargets(spec, "main", "dev", ["db"])).toBe(false);
    expect(tipAppliesTargets(null, "main", "dev", ["network"])).toBe(false);
    expect(tipAppliesTargets({ ...spec, waves: [{ name: "dev", runs: [], discover: true }] }, "main", "dev", ["anything"])).toBe(true);
  });

  test("the reason names the branch, both commits and the targets", () => {
    const n = { branch: "main", head: "a".repeat(40), tip: "c".repeat(40) };
    expect(opWaveStandDownReason(n, ["prod"])).toBe(`main on origin is at ${"c".repeat(12)}, newer than this run's ${"a".repeat(12)}, and its own wave applies prod`);
    expect(opWaveStandDownReason(n, ["a", "b"])).toContain("2 targets (a, b)");
  });
});
