import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { contentDigest } from "../content-digest";
import type { GateLedgerPort } from "../op/gate";
import type { PromoteRunner } from "./promote";
import { parseStateMappings, planWaves, promoteWavesCommand, stateRefusal, type WavesSummary } from "./promote-waves";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf-8" });

interface Pending {
  gate: string;
  planDigest?: string;
  description?: string;
  timestamp: string;
}

/** A gate ledger in memory: pending facts as evaluateGate records them, and approvals of the newest one per gate. */
function ledger(): GateLedgerPort & { pending: Pending[]; approve(gate: string): void } {
  const pending: Pending[] = [];
  const resolutions: unknown[] = [];
  return {
    pending,
    async read() {
      return { resolutions, pending } as never;
    },
    async appendPending(input: Record<string, unknown>) {
      const record = { version: 1, kind: "pending", ...input };
      pending.push(record as unknown as Pending);
      return { record, pushed: false } as never;
    },
    approve(gate: string) {
      const standing = pending.filter((p) => p.gate === gate).at(-1)!;
      const after = new Date(new Date(standing.timestamp).getTime() + 1000).toISOString();
      resolutions.push({ version: 1, op: "workspace-promote", gate, planDigest: standing.planDigest, resolvedBy: "alex", outcome: "approved", timestamp: after });
    },
  } as never;
}

/** The report the fake live-import prints for an estate, in choudoufu's layout: two verified, one unadmitted. */
const reportFor = (estate: string, extra = "") =>
  [
    `Ratifying /s/${estate}.tfstate for estate "${estate}" against the live system. This was read-only: nothing was written.`,
    "",
    "VERIFIED (2) - verified against the live system:",
    `  aws_s3_bucket.${estate}                    aws_s3_bucket            live id: ${estate}-bucket`,
    "    matches",
    `  aws_sqs_queue.${estate}                    aws_sqs_queue            live id: ${estate}-queue`,
    "    matches",
    "",
    "UNADMITTED_TYPE (1) - outside the admitted type set:",
    "  aws_x.y                                    aws_x                    live id: -",
    "    not admitted",
    "",
    `2 of 3 resource instance(s) are eligible for stamping (VERIFIED or DRIFTED).${extra}`,
    "",
  ].join("\n");

describe("planWaves (#4461)", () => {
  test("the canary is wave 1, the rest follow in order at the wave size", () => {
    expect(planWaves(["a", "b", "c", "d", "e"], ["c"], 2)).toEqual([["c"], ["a", "b"], ["d", "e"]]);
    expect(planWaves(["a", "b", "c"], [], 5)).toEqual([["a"], ["b", "c"]]);
    expect(() => planWaves(["a"], ["z"], 1)).toThrow(/--canary z/);
    expect(() => planWaves(["a"], [], 0)).toThrow(/--wave-size/);
  });
  test("--state takes <member>=<path>", () => {
    expect(parseStateMappings(["a=/s/a.tfstate", "b=x=y"])).toEqual({ a: "/s/a.tfstate", b: "x=y" });
    expect(() => parseStateMappings(["/s/a.tfstate"])).toThrow(/<member>=/);
  });
});

describe("chant workspace promote --all (#4461)", () => {
  let root: string;
  let states: string;
  let calls: { argv: string[]; cwd: string }[];
  let failCheck: Set<string>;
  let reportExtra: Map<string, string>;

  const memberOf = (argv: string[], cwd: string): string => argv.find((a) => a.startsWith("-estate="))?.slice("-estate=".length) ?? basename(cwd);
  const runner: PromoteRunner = async (argv, cwd) => {
    calls.push({ argv, cwd });
    const member = memberOf(argv, cwd);
    if (argv[1] === "live-check") return failCheck.has(member) ? { exitCode: 2, output: "unsupported construct: provisioner" } : { exitCode: 0, output: "" };
    if (argv.includes("-approve")) return { exitCode: 0, output: "2 resource(s) newly stamped, 0 already stamped, 0 newly recorded, 0 re-recorded for sensitivity only, 0 already recorded, 0 failed, 1 skipped.\n" };
    return { exitCode: 0, output: reportFor(member, reportExtra.get(member)) };
  };

  const v4 = JSON.stringify({ version: 4, terraform_version: "1.5.7", serial: 1, lineage: "l", outputs: {}, resources: [] });
  const members = ["a", "b", "c", "d"];

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    calls = [];
    failCheck = new Set();
    reportExtra = new Map();
    root = mkdtempSync(join(tmpdir(), "chant-promote-waves-"));
    states = mkdtempSync(join(tmpdir(), "chant-promote-waves-states-"));
    git(root, "init", "-q", "-b", "main");
    for (const m of members) {
      mkdirSync(join(root, m));
      writeFileSync(join(root, m, "main.tf"), "# tf\n");
      writeFileSync(join(states, `${m}.tfstate`), v4);
    }
    writeFileSync(
      join(root, "chant.workspace.json"),
      JSON.stringify({ name: "w", schema: 1, members: members.map((m) => ({ name: m, dir: m, kind: "terraform" })) }, null, 2) + "\n",
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(states, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const kinds = () => Object.fromEntries(JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf-8")).members.map((m: { name: string; kind: string }) => [m.name, m.kind]));
  const outcomes = (s: WavesSummary) => Object.fromEntries(s.roots.map((r) => [r.member, r.outcome]));
  const promote = (l: GateLedgerPort, extra: { canary?: string[]; waveSize?: number } = {}) =>
    promoteWavesCommand({ root, all: true, stateDir: states, canary: ["b"], waveSize: 2, json: true, runner, ledger: l, ...extra });

  test("a failing canary stops every later wave and leaves the tree alone", async () => {
    const l = ledger();
    failCheck.add("b");
    const s = await promote(l);
    expect(s.waves).toEqual([["b"], ["a", "c"], ["d"]]);
    expect(outcomes(s)).toEqual({ b: "checks-failed", a: "not-run", c: "not-run", d: "not-run" });
    expect(s.exitCode).toBe(1);
    expect(calls.every((c) => basename(c.cwd) === "b")).toBe(true);
    expect(l.pending).toHaveLength(0);
    expect(kinds()).toEqual({ a: "terraform", b: "terraform", c: "terraform", d: "terraform" });
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  test("one gate per root, each bound to that root's own live-import report digest", async () => {
    const l = ledger();

    const first = await promote(l);
    expect(outcomes(first)).toEqual({ b: "gated", a: "not-run", c: "not-run", d: "not-run" });
    expect(first.exitCode).toBe(3);
    expect(l.pending.map((p) => p.gate)).toEqual(["b"]);
    const b = first.roots.find((r) => r.member === "b")!;
    expect(b.reportDigest).toBe(contentDigest(reportFor("b").trimEnd()));
    expect(l.pending[0].planDigest).toBe(b.digest);
    expect(l.pending[0].description).toContain(b.reportDigest);
    expect(b.eligible).toEqual({ stampable: 2, total: 3 });
    expect(b.unadmitted).toBe(1);

    l.approve("b");
    calls = [];
    const second = await promote(l);
    expect(outcomes(second)).toEqual({ b: "applied", a: "gated", c: "gated", d: "not-run" });
    expect(second.roots.find((r) => r.member === "b")!.stamped).toEqual({ newly: 2, already: 0, failed: 0 });
    expect(calls.filter((c) => c.argv.includes("-approve")).map((c) => c.cwd)).toEqual([join(realpathSync(root), "b")]);
    expect(kinds()).toMatchObject({ b: "choudoufu", a: "terraform", c: "terraform" });

    const gateOf = (m: string) => l.pending.filter((p) => p.gate === m);
    const rowOf = (s: WavesSummary, m: string) => s.roots.find((r) => r.member === m)!;
    expect(gateOf("a")).toHaveLength(1);
    expect(gateOf("c")).toHaveLength(1);
    expect(gateOf("a")[0].planDigest).toBe(rowOf(second, "a").digest);
    expect(gateOf("c")[0].planDigest).toBe(rowOf(second, "c").digest);
    expect(rowOf(second, "a").digest).not.toBe(rowOf(second, "c").digest);
    expect(rowOf(second, "a").reportDigest).toBe(contentDigest(reportFor("a").trimEnd()));
    expect(rowOf(second, "c").reportDigest).toBe(contentDigest(reportFor("c").trimEnd()));

    // a's approval is for the report its approver read: a changed report is a new digest and stays gated.
    l.approve("a");
    l.approve("c");
    reportExtra.set("a", "\nDRIFTED (1) - verified, but drifted from the live system:");
    const third = await promote(l);
    expect(outcomes(third)).toMatchObject({ b: "already-promoted", a: "gated", c: "applied", d: "not-run" });
    expect(kinds()).toMatchObject({ a: "terraform", c: "choudoufu" });
  });

  test("within a wave a failed root leaves the others to run, and the next wave waits", async () => {
    const l = ledger();
    await promote(l);
    l.approve("b");
    failCheck.add("a");
    const s = await promote(l);
    expect(outcomes(s)).toEqual({ b: "applied", a: "checks-failed", c: "gated", d: "not-run" });
    expect(s.exitCode).toBe(1);
    expect(l.pending.filter((p) => p.gate === "a")).toHaveLength(0);
    expect(kinds()).toMatchObject({ a: "terraform", b: "choudoufu", c: "terraform", d: "terraform" });
    expect(s.roots.find((r) => r.member === "d")!.reason).toMatch(/wave 2 did not land \(a checks-failed, c gated\)/);
  });

  test("re-running over a landed workspace is a no-op", async () => {
    const l = ledger();
    const all = { waveSize: 3 };
    await promote(l, all);
    l.approve("b");
    await promote(l, all);
    for (const m of ["a", "c", "d"]) l.approve(m);
    const landed = await promote(l, all);
    expect(outcomes(landed)).toEqual({ b: "already-promoted", a: "applied", c: "applied", d: "applied" });
    expect(landed.exitCode).toBe(0);

    calls = [];
    const pendingBefore = l.pending.length;
    const again = await promote(l, all);
    expect(outcomes(again)).toEqual({ b: "already-promoted", a: "already-promoted", c: "already-promoted", d: "already-promoted" });
    expect(again.exitCode).toBe(0);
    expect(again.outcome).toBe("landed");
    expect(calls).toHaveLength(0);
    expect(l.pending).toHaveLength(pendingBefore);
  });

  test("a root without a local v4 state is refused by name and stages nothing", async () => {
    const l = ledger();
    writeFileSync(join(root, "a", "backend.tf"), 'terraform {\n  backend "s3" {}\n}\n');
    git(root, "add", "-A");
    git(root, "commit", "-qm", "s3");
    rmSync(join(states, "a.tfstate"));
    writeFileSync(join(states, "c.tfstate"), JSON.stringify({ version: 3, serial: 1 }));
    const s = await promoteWavesCommand({ root, all: true, stateDir: states, canary: ["b"], waveSize: 3, json: true, runner, ledger: l });
    l.approve("b");
    const second = await promoteWavesCommand({ root, all: true, stateDir: states, canary: ["b"], waveSize: 3, json: true, runner, ledger: l });
    expect(outcomes(s).b).toBe("gated");
    const row = (m: string) => second.roots.find((r) => r.member === m)!;
    expect(row("a").outcome).toBe("refused");
    expect(row("a").reason).toMatch(/a uses the s3 backend .*terraform state pull/);
    expect(row("c").outcome).toBe("refused");
    expect(row("c").reason).toMatch(/version 3 state; live-import reads version 4/);
    expect(row("d").outcome).toBe("gated");
    expect(calls.some((c) => memberOf(c.argv, c.cwd) === "a" || memberOf(c.argv, c.cwd) === "c")).toBe(false);
  });

  test("stateRefusal accepts a local v4 state", () => {
    expect(stateRefusal("a", join(root, "a"), join(states, "a.tfstate"))).toBeUndefined();
  });
});
