import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, opWavesPostsApprovalStatus, type OpWavesSpec } from "./op-waves";
import { OP_WAVES_PREVIEW_FLOOR, readOpWavePolicy, runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { NEXT_RELEASE } from "../release-floors";
import { waveSetDigest } from "../gated-waves";
import type { HeadPlans, MergedReview, ReviewSource } from "./gate-review";

const spec: OpWavesSpec = {
  name: "records",
  op: "dns",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  approvals: { preview: true },
  waves: [{ name: "dev", runs: [{ target: "zone" }], gate: "on-destructive" }],
};

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const setOf = (n: string) => waveSetDigest([{ member: "zone", planDigest: digest(n) }]);
const merged: MergedReview = { pr: 7, head: "h".repeat(40), author: "github:dev", approvers: ["github:rev"], refused: [] };
const reviews = (m: MergedReview | null): ReviewSource => ({ kind: "github", mergedReview: async () => m });
const recorded = (wave: number, set: string | undefined): ((name: string, head: string) => Promise<HeadPlans | null>) => async (name, head) =>
  set === undefined ? null : { version: 1, name, head, timestamp: "2026-10-30T00:00:00Z", waves: [{ wave, name: "dev", digest: set }] };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(plan: { planDigest: string; destructive?: boolean }, atBase: OpWavesSpec = spec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-preview-"));
  dirs.push(cwd);
  const calls: string[] = [];
  const exec: OpWaveExec = (argv, dir) => {
    calls.push(argv.join(" "));
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify(plan));
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(atBase) });
  return { cwd, exec, show, applied: () => calls.some((c) => c.startsWith("tool apply")) };
}

const run = (h: ReturnType<typeof harness>, extra: Partial<Parameters<typeof runOpWave>[0]> = {}) =>
  runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), head: "m".repeat(40), now: "2026-10-30T01:00:00Z", log: () => {}, ...extra });

describe("a wave applies the plans its pull request previewed (approvals.preview)", () => {
  test("a record that moved between the preview and the merge returns 4 and applies nothing", async () => {
    const h = harness({ planDigest: digest("b") });
    const logs: string[] = [];
    const result = await run(h, { reviews: reviews(merged), headPlans: recorded(1, setOf("a")), log: (l) => logs.push(l) });
    expect(result.exitCode).toBe(4);
    expect(result.moved).toEqual(["zone"]);
    expect(result.decision).toMatchObject({ status: "refused", refused: { reason: "moved", runs: ["zone"] }, preview: { status: "moved", pr: 7, recorded: setOf("a") } });
    expect(result.decision?.refused?.message).toMatch(/the head hhhhhhhhhhhh planned/);
    expect(h.applied()).toBe(false);
    expect(logs.some((l) => /plans moved since #7 previewed them/.test(l))).toBe(true);
  });

  test("an unchanged record applies, though the gate asks for no approval", async () => {
    const h = harness({ planDigest: digest("a") });
    const result = await run(h, { reviews: reviews(merged), headPlans: recorded(1, setOf("a")) });
    expect(result).toMatchObject({ exitCode: 0, applied: ["zone"], decision: { status: "not-required", preview: { status: "matched", pr: 7 } } });
    expect(h.applied()).toBe(true);
  });

  test("a destructive change still waits for its approval when the preview matches", async () => {
    const h = harness({ planDigest: digest("a"), destructive: true });
    const gates = memoryGateLedgerPort();
    const result = await run(h, { gates, reviews: reviews(merged), headPlans: recorded(1, setOf("a")) });
    expect(result.exitCode).toBe(3);
    expect(result.decision).toMatchObject({ status: "waiting", preview: { status: "matched" } });
    expect(h.applied()).toBe(false);
    const approved = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: "records", gate: "records-wave-1", resolvedBy: "alice", timestamp: "2026-10-30T00:30:00Z", planDigest: setOf("a") }],
    });
    const again = await run(h, { gates: approved, reviews: reviews(merged), headPlans: recorded(1, setOf("a")) });
    expect(again).toMatchObject({ exitCode: 0, applied: ["zone"], decision: { status: "approved", approvedBy: "alice" } });
  });

  test("with no approval required, the wave compares with the digest of the preview it was shown", async () => {
    // gate: never needs nothing, yet the preview still binds the plans.
    const never: OpWavesSpec = { ...spec, waves: [{ ...spec.waves[0]!, gate: "never" }] };
    const moved = harness({ planDigest: digest("c") }, never);
    const refused = await run(moved, { spec: never, reviews: reviews(merged), headPlans: recorded(1, setOf("a")) });
    expect(refused).toMatchObject({ exitCode: 4, decision: { policy: "never", preview: { status: "moved" } } });
    expect(moved.applied()).toBe(false);
    const same = harness({ planDigest: digest("a") }, never);
    expect(await run(same, { spec: never, reviews: reviews(merged), headPlans: recorded(1, setOf("a")) })).toMatchObject({ exitCode: 0, applied: ["zone"] });
  });

  test("plans nobody previewed refuse too: no merged pull request, or no record for its head", async () => {
    const direct = harness({ planDigest: digest("a") });
    const none = await run(direct, { reviews: reviews(null), headPlans: recorded(1, setOf("a")) });
    expect(none).toMatchObject({ exitCode: 4, decision: { preview: { status: "unrecorded" } } });
    expect(none.decision?.refused?.message).toMatch(/no merged pull request produced/);
    const unrecorded = harness({ planDigest: digest("a") });
    const missing = await run(unrecorded, { reviews: reviews(merged), headPlans: recorded(1, undefined) });
    expect(missing).toMatchObject({ exitCode: 4, decision: { preview: { status: "unrecorded" } } });
    expect(missing.decision?.refused?.message).toMatch(/--record-plans/);
    expect(direct.applied() || unrecorded.applied()).toBe(false);
  });

  test("an approval of the plans made now lets a moved wave apply, and the refusal names the command", async () => {
    const h = harness({ planDigest: digest("b") });
    const refused = await run(h, { reviews: reviews(merged), headPlans: recorded(1, setOf("a")) });
    expect(refused.decision?.refused?.message).toContain(`chant approve records records-wave-1 ${setOf("b")}`.split(" ").slice(0, 3).join(" "));
    expect(refused.decision?.approve).toContain(setOf("b"));
    const approved = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: "records", gate: "records-wave-1", resolvedBy: "alice", timestamp: "2026-10-30T00:45:00Z", planDigest: setOf("b") }],
    });
    const result = await run(h, { gates: approved, reviews: reviews(merged), headPlans: recorded(1, setOf("a")) });
    expect(result).toMatchObject({ exitCode: 0, applied: ["zone"], decision: { status: "approved", approvedBy: "alice", preview: { status: "moved", approvedAnyway: true } } });
  });

  test("a forge that cannot be read fails the wave and applies nothing", async () => {
    const h = harness({ planDigest: digest("a") });
    const broken: ReviewSource = { kind: "github", mergedReview: async () => { throw new Error("403"); } };
    const result = await run(h, { reviews: broken, headPlans: recorded(1, setOf("a")) });
    expect(result.exitCode).toBe(1);
    expect(h.applied()).toBe(false);
  });

  test("a change cannot switch it off: the setting is read at base", async () => {
    const h = harness({ planDigest: digest("b") });
    const off: OpWavesSpec = { ...spec, approvals: { preview: false } };
    const result = await run(h, { spec: off, reviews: reviews(merged), headPlans: recorded(1, setOf("a")) });
    expect(result.exitCode).toBe(4);
    const without = harness({ planDigest: digest("b") }, { ...spec, approvals: {} });
    expect(await run(without, { reviews: reviews(merged), headPlans: recorded(1, setOf("a")) })).toMatchObject({ exitCode: 0, applied: ["zone"] });
  });

  test("a spec without it keeps the behaviour it had", async () => {
    const plain: OpWavesSpec = { ...spec, approvals: {} };
    const h = harness({ planDigest: digest("b") }, plain);
    const result = await run(h, { spec: plain });
    expect(result).toMatchObject({ exitCode: 0, applied: ["zone"], decision: { status: "not-required" } });
    expect(result.decision?.preview).toBeUndefined();
  });

  test("a share job ends on a moved decision with 4", async () => {
    const wide: OpWavesSpec = { ...spec, waves: [{ name: "dev", runs: [{ target: "zone" }, { target: "zone2" }], gate: "on-destructive", shares: 2 }] };
    const h = harness({ planDigest: digest("b") }, wide);
    const decided = await run(h, { spec: wide, decide: true, reviews: reviews(merged), headPlans: recorded(1, waveSetDigest([{ member: "zone", planDigest: digest("a") }, { member: "zone2", planDigest: digest("a") }])) });
    expect(decided.exitCode).toBe(4);
    const share = await run(h, { spec: wide, share: 1 });
    expect(share.exitCode).toBe(4);
    expect(h.applied()).toBe(false);
  });
});

describe("the setting", () => {
  test("its floor is the next release", () => {
    expect(OP_WAVES_PREVIEW_FLOOR).toBe(NEXT_RELEASE);
  });

  test("is a boolean, is read at base, and makes the head record its plans", () => {
    expect(() => assertOpWavesSpec(spec)).not.toThrow();
    expect(() => assertOpWavesSpec({ ...spec, approvals: { preview: "yes" } } as unknown as OpWavesSpec)).toThrow(/approvals.preview must be true or false/);
    expect(readOpWavePolicy("waves.json", "dev", "HEAD", "/", () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) })).preview).toBe(true);
    expect(readOpWavePolicy("waves.json", "dev", "HEAD", "/", () => ({ sha: "b".repeat(40), text: JSON.stringify({ ...spec, approvals: {} }) })).preview).toBeUndefined();
    expect(opWavesPostsApprovalStatus(spec)).toBe(true);
    expect(opWavesPostsApprovalStatus({ ...spec, approvals: {} })).toBe(false);
  });
});
