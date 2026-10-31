import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, opWavesPostsApprovalStatus, type OpWavesSpec } from "./op-waves";
import { OP_WAVES_PREVIEW_FLOOR, readOpWavePolicy, runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { NEXT_RELEASE } from "../release-floors";
import { waveSetDigest } from "../gated-waves";
import type { HeadPlanMember, HeadPlans, MergedReview, ReviewSource } from "./gate-review";
import { movedSincePreview, shortAddress } from "./op-waves-preview";

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

/** A record as chant after 0.124.59 writes it: the set digest, and each run's resources. */
const recordedRuns = (wave: number, members: HeadPlanMember[]): ((name: string, head: string) => Promise<HeadPlans | null>) => async (name, head) => ({
  version: 1,
  name,
  head,
  timestamp: "2026-10-30T00:00:00Z",
  waves: [{ wave, name: "dev", digest: waveSetDigest(members.map((m) => ({ member: m.member, planDigest: m.planDigest }))), members }],
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(plan: { planDigest: string; destructive?: boolean; resources?: Record<string, string> }, atBase: OpWavesSpec = spec) {
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

describe("a wave compares the resources its pull request's plan changed (plywood#55)", () => {
  // shop/dev holds an events queue and a set of worker queues. One pull request changes the events queue (EV), another adds a worker (WK).
  const stack = "zone";
  const EV = "urn:pulumi:dev::shop::aws:sqs/queue:Queue::events";
  const WK = "urn:pulumi:dev::shop::aws:sqs/queue:Queue::worker-3";
  const eventsPr: MergedReview = { pr: 3, head: "e".repeat(40), author: "github:dev", approvers: ["github:rev"], refused: [] };
  const workersPr: MergedReview = { pr: 4, head: "w".repeat(40), author: "github:dev", approvers: ["github:rev"], refused: [] };
  // What each pull request previewed against main before either merged.
  const previewedEvents: HeadPlanMember[] = [{ member: stack, planDigest: digest("1"), resources: { [EV]: digest("e") } }];
  const previewedWorkers: HeadPlanMember[] = [{ member: stack, planDigest: digest("2"), resources: { [WK]: digest("w") } }];

  test("two pull requests that touch different resources both apply when merged in sequence", async () => {
    // The first merge plans the events change alone.
    const first = harness({ planDigest: digest("3"), resources: { [EV]: digest("e") } });
    const one = await run(first, { reviews: reviews(eventsPr), headPlans: recordedRuns(1, previewedEvents) });
    expect(one).toMatchObject({ exitCode: 0, applied: [stack], decision: { status: "not-required", preview: { status: "matched", pr: 3, compared: "resources" } } });
    expect(first.applied()).toBe(true);
    // The second merge plans while the first one's step is still in its plan: its set digest is neither pull request's.
    const second = harness({ planDigest: digest("4"), resources: { [EV]: digest("e"), [WK]: digest("w") } });
    const two = await run(second, { reviews: reviews(workersPr), headPlans: recordedRuns(1, previewedWorkers) });
    expect(two).toMatchObject({ exitCode: 0, applied: [stack], decision: { status: "not-required", preview: { status: "matched", pr: 4, compared: "resources" } } });
    expect(two.decision?.digest).not.toBe(two.decision?.preview?.recorded);
    expect(second.applied()).toBe(true);
  });

  test("the second merge applies too when the first one has applied before it plans", async () => {
    // The events queue is unchanged now but its recorded inputs are the new ones, so the stack's plan digest moved.
    const second = harness({ planDigest: digest("5"), resources: { [WK]: digest("w") } });
    const result = await run(second, { reviews: reviews(workersPr), headPlans: recordedRuns(1, previewedWorkers) });
    expect(result).toMatchObject({ exitCode: 0, applied: [stack], decision: { preview: { status: "matched", compared: "resources" } } });
    expect(second.applied()).toBe(true);
  });

  test("a pull request whose touched resource moved after another merge still returns 4", async () => {
    // The other merge changed the worker queue the second pull request planned a change to.
    const h = harness({ planDigest: digest("6"), resources: { [EV]: digest("e"), [WK]: digest("x") } });
    const logs: string[] = [];
    const result = await run(h, { reviews: reviews(workersPr), headPlans: recordedRuns(1, previewedWorkers), log: (l) => logs.push(l) });
    expect(result.exitCode).toBe(4);
    expect(result.moved).toEqual([stack]);
    expect(result.decision).toMatchObject({ status: "refused", refused: { reason: "moved" }, preview: { status: "moved", compared: "resources", moved: [`${stack}: aws:sqs/queue:Queue::worker-3 is planned differently`] } });
    expect(result.decision?.refused?.message).toMatch(/worker-3 is planned differently/);
    expect(h.applied()).toBe(false);
  });

  test("a resource the pull request changed that the merge no longer changes returns 4", async () => {
    const h = harness({ planDigest: digest("7"), resources: { [EV]: digest("e") } });
    const result = await run(h, { reviews: reviews(workersPr), headPlans: recordedRuns(1, previewedWorkers) });
    expect(result).toMatchObject({ exitCode: 4, decision: { preview: { status: "moved", moved: [`${stack}: aws:sqs/queue:Queue::worker-3 is no longer changed by the plans`] } } });
    expect(h.applied()).toBe(false);
  });

  test("a run the pull request changed that the wave no longer plans returns 4", () => {
    expect(movedSincePreview(previewedWorkers, [])).toEqual([`${stack} is no longer in the wave`]);
  });

  test("a destructive change another merge added still waits for its approval", async () => {
    const h = harness({ planDigest: digest("8"), destructive: true, resources: { [EV]: digest("d"), [WK]: digest("w") } });
    const result = await run(h, { reviews: reviews(workersPr), headPlans: recordedRuns(1, previewedWorkers) });
    expect(result).toMatchObject({ exitCode: 3, decision: { status: "waiting", preview: { status: "matched" } } });
    expect(h.applied()).toBe(false);
    const approved = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: "records", gate: "records-wave-1", resolvedBy: "alice", timestamp: "2026-10-30T00:30:00Z", planDigest: result.decision!.digest }],
    });
    expect(await run(h, { gates: approved, reviews: reviews(workersPr), headPlans: recordedRuns(1, previewedWorkers) })).toMatchObject({ exitCode: 0, applied: [stack], decision: { status: "approved" } });
  });

  test("an approval of the digest planned now lets a moved resource through", async () => {
    const h = harness({ planDigest: digest("6"), resources: { [WK]: digest("x") } });
    const refused = await run(h, { reviews: reviews(workersPr), headPlans: recordedRuns(1, previewedWorkers) });
    expect(refused.exitCode).toBe(4);
    const approved = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: "records", gate: "records-wave-1", resolvedBy: "alice", timestamp: "2026-10-30T00:30:00Z", planDigest: refused.decision!.digest }],
    });
    const result = await run(h, { gates: approved, reviews: reviews(workersPr), headPlans: recordedRuns(1, previewedWorkers) });
    expect(result).toMatchObject({ exitCode: 0, applied: [stack], decision: { status: "approved", preview: { status: "moved", approvedAnyway: true } } });
  });

  test("a run recorded with no resources is compared whole, and one that changed nothing is not compared", async () => {
    const whole: HeadPlanMember[] = [{ member: stack, planDigest: digest("a") }];
    const moved = harness({ planDigest: digest("b") });
    expect(await run(moved, { reviews: reviews(merged), headPlans: recordedRuns(1, whole) })).toMatchObject({ exitCode: 4, decision: { preview: { compared: "resources", moved: [`${stack}: its plan is another digest`] } } });
    const same = harness({ planDigest: digest("a") });
    expect(await run(same, { reviews: reviews(merged), headPlans: recordedRuns(1, whole) })).toMatchObject({ exitCode: 0, applied: [stack] });
    const nothing = harness({ planDigest: digest("c"), resources: { [EV]: digest("e") } });
    expect(await run(nothing, { reviews: reviews(merged), headPlans: recordedRuns(1, [{ member: stack, planDigest: digest("a"), empty: true }]) })).toMatchObject({ exitCode: 0, applied: [stack] });
  });

  test("a record written by 0.124.59 holds the set digest only, and is compared whole with a message saying so", async () => {
    const h = harness({ planDigest: digest("b"), resources: { [WK]: digest("w") } });
    const result = await run(h, { reviews: reviews(merged), headPlans: recorded(1, setOf("a")) });
    expect(result).toMatchObject({ exitCode: 4, decision: { preview: { status: "moved", compared: "wave", recorded: setOf("a") } } });
    expect(result.decision?.refused?.message).toMatch(/written by chant 0\.124\.59, which keeps the wave's digest only/);
    const same = harness({ planDigest: digest("a"), resources: { [WK]: digest("w") } });
    expect(await run(same, { reviews: reviews(merged), headPlans: recorded(1, setOf("a")) })).toMatchObject({ exitCode: 0, applied: [stack], decision: { preview: { status: "matched", compared: "wave" } } });
  });

  test("the plan file's resources are checked", async () => {
    const h = harness({ planDigest: digest("a"), resources: { [WK]: 5 as unknown as string } });
    await expect(run(h, { reviews: reviews(merged), headPlans: recorded(1, setOf("a")) })).rejects.toThrow(/map of a resource's address to its digest/);
  });

  test("an address reads short", () => {
    expect(shortAddress(EV)).toBe("aws:sqs/queue:Queue::events");
    expect(shortAddress("aws_s3_bucket.logs")).toBe("aws_s3_bucket.logs");
  });
});
