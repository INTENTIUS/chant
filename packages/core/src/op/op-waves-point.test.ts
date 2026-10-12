/**
 * A wave gate that asks a workspace decision point (#3836), against a stub
 * asker and an in-memory gate ledger: the point is read at base, an open
 * question waits (exit 3) with a pending fact citing it and the `points
 * answer` line as `approve`, a passing answer for the set digest lets the
 * wave apply under a resolution that cites it, any other answer refuses the
 * wave (exit 8), and the waiting pending fact is what `chant run resume`
 * resumes once the question is answered (#3835).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveDecision, type OpWaveExec, type OpWaveRunsFile, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { waveSetDigest } from "../gated-waves";
import { pointGateResumable, type GatePointAsker, type GatePointQuestion, type GatePointRequest } from "../point-decision";
import { resumeStanding } from "../cli/handlers/gate-resume";
import { opWaveNotifyFields } from "./op-waves-notify";

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const NOW = "2026-10-11T10:00:00.000Z";

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "apply",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  point: { name: "prod-apply", timeout: "48h" },
  waves: [
    { name: "prod", runs: [{ target: "db" }, { target: "net" }], gate: "always" },
    { name: "wide", runs: [{ target: "a" }, { target: "b" }], gate: "always", shares: 2 },
  ],
};

/** A stub asker: each question's state comes from `answers`, by the plan digest it was asked about. */
function stubAsker(answers: Map<string, Partial<GatePointQuestion>> = new Map()): GatePointAsker & { asked: GatePointRequest[] } {
  const asked: GatePointRequest[] = [];
  return {
    asked,
    async ask(request) {
      asked.push(request);
      const id = `${request.point}-${(request.facts.planDigest ?? "none").slice(7, 19)}`;
      return {
        id,
        point: request.point,
        path: `.chant/answers/${id}.md`,
        state: "escalated",
        answer: null,
        decider: "quorum",
        answeredBy: [],
        subject: request.subject,
        steward: null,
        ...(answers.get(request.facts.planDigest ?? "") ?? {}),
      };
    },
  };
}

function harness(atBase: OpWavesSpec | null = spec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-point-"));
  const calls: string[] = [];
  const exec: OpWaveExec = (argv, dir) => {
    calls.push(argv.join(" "));
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest(argv[2]!.slice(0, 1)) }));
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: atBase === null ? null : JSON.stringify(atBase) });
  return { cwd, calls, exec, show, applied: () => calls.filter((c) => c.startsWith("tool apply")), done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const prodSet = waveSetDigest([
  { member: "db", planDigest: digest("d") },
  { member: "net", planDigest: digest("n") },
]);

afterEach(() => vi.unstubAllEnvs());

describe("a wave gate that asks a decision point (#3836)", () => {
  test("the spec takes a point on the spec or a wave, and refuses a bad one", () => {
    expect(() => assertOpWavesSpec(spec)).not.toThrow();
    expect(() => assertOpWavesSpec({ ...spec, point: "prod-apply" })).not.toThrow();
    expect(() => assertOpWavesSpec({ ...spec, point: { name: "Prod Apply" } })).toThrow(/decision point's name/);
    expect(() => assertOpWavesSpec({ ...spec, point: { name: "prod-apply", timeout: "soon" } })).toThrow(/point.timeout/);
    expect(() => assertOpWavesSpec({ ...spec, waves: [{ ...spec.waves[0]!, point: { name: "prod-apply", inputs: { "gate.planDigest": "x" } } }] })).toThrow(/wave "prod".*passes itself/);
  });

  test("a wave waits on the point's question, it is answered yes, and the wave applies under a resolution that cites the answer", async () => {
    const h = harness();
    const gates = memoryGateLedgerPort();
    const answers = new Map<string, Partial<GatePointQuestion>>();
    const asker = stubAsker(answers);

    const waiting = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates, points: asker, now: NOW, log: () => {} });
    expect(waiting.exitCode).toBe(3);
    expect(asker.asked[0]).toMatchObject({ point: "prod-apply", facts: { component: "tf-apply", name: "tf-apply-wave-1", planDigest: prodSet }, subject: "gate:tf-apply/tf-apply-wave-1" });
    const id = asker.asked[0]!.point + "-" + prodSet.slice(7, 19);
    expect(waiting.decision).toMatchObject({
      status: "waiting",
      digest: prodSet,
      point: { name: "prod-apply", question: { id, state: "escalated" } },
      approve: `chant workspace points answer ${id} --answer <answer> --by <your name>`,
      pendingFact: { gate: "tf-apply-wave-1", planDigest: prodSet, answer: { point: "prod-apply", id } },
    });
    // The pending fact stands for 48h, as the point's timeout says.
    expect(gates.appended[0]!.expiresAt).toBe("2026-10-13T10:00:00.000Z");
    expect(h.applied()).toEqual([]);
    expect(opWaveNotifyFields(spec, 1, { result: waiting })).toMatchObject({ event: "waiting", approve: { command: expect.stringContaining("points answer") } });

    // A `chant approve` of the digest does not pass a gate that asks a point.
    const approvedByHand = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "tf-apply", gate: "tf-apply-wave-1", resolvedBy: "mallory", timestamp: NOW, planDigest: prodSet }] });
    expect((await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: approvedByHand, points: stubAsker(), now: NOW, log: () => {} })).exitCode).toBe(3);

    answers.set(prodSet, { state: "answered", answer: true, answeredBy: ["alice"] });
    const passed = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates, points: asker, now: NOW, log: () => {} });
    expect(passed).toMatchObject({ exitCode: 0, applied: ["db", "net"], decision: { status: "approved", via: "point", approvedBy: "alice", point: { answer: { id, answer: true } } } });
    expect(gates.resolved).toHaveLength(1);
    expect(gates.resolved[0]).toMatchObject({ gate: "tf-apply-wave-1", planDigest: prodSet, answer: { point: "prod-apply", id, answer: true } });

    // Asked again for the same plan, the resolution already stands: none is written twice.
    await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates, points: asker, now: NOW, log: () => {} });
    expect(gates.resolved).toHaveLength(1);
    h.done();
  });

  test("each plan is its own question: a yes for one set digest does not pass another", async () => {
    const h = harness();
    const other = digest("z");
    const asker = stubAsker(new Map([[other, { state: "answered", answer: true, answeredBy: ["alice"] }]]));
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), points: asker, now: NOW, log: () => {} });
    expect(result.exitCode).toBe(3);
    h.done();
  });

  test("an answer the gate does not pass on refuses the wave with exit 8, and nothing applies", async () => {
    const h = harness();
    const asker = stubAsker(new Map([[prodSet, { state: "answered", answer: false, answeredBy: ["bob"] }]]));
    const logs: string[] = [];
    const refused = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), points: asker, now: NOW, log: (l) => logs.push(l) });
    expect(refused).toMatchObject({
      exitCode: 8,
      applied: [],
      decision: { status: "refused", refused: { reason: "point", runs: ["db", "net"] }, point: { answer: { answer: false } } },
    });
    expect(refused.decision!.refused!.message).toMatch(/answered false .* passes only on true/);
    expect(h.applied()).toEqual([]);
    expect(opWaveNotifyFields(spec, 1, { result: refused })).toMatchObject({ event: "refused", status: "point", targets: ["db", "net"] });
    h.done();
  });

  test("a wide wave's shares refuse with exit 8 when the deciding job's point said no", async () => {
    const h = harness();
    const set = waveSetDigest([
      { member: "a", planDigest: digest("a") },
      { member: "b", planDigest: digest("b") },
    ]);
    const asker = stubAsker(new Map([[set, { state: "answered", answer: false, answeredBy: ["bob"] }]]));
    const decided = await runOpWave({ spec, specFile: "waves.json", wave: 2, decide: true, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), points: asker, now: NOW, log: () => {} });
    expect(decided.exitCode).toBe(8);
    const record = JSON.parse(readFileSync(join(h.cwd, ".chant/op-waves/tf-apply/wave-2.json"), "utf-8")) as OpWaveDecision;
    expect(record.refused?.reason).toBe("point");
    const share = await runOpWave({ spec, specFile: "waves.json", wave: 2, share: 1, cwd: h.cwd, exec: h.exec, show: h.show, log: () => {} });
    expect(share.exitCode).toBe(8);
    expect(h.applied()).toEqual([]);
    h.done();
  });

  test("the point is read at base: a change can neither add one nor drop one for its own gate", async () => {
    const bare: OpWavesSpec = { ...spec, point: undefined };
    // The change adds a point, the base has none: the ledger decides.
    const added = harness(bare);
    const ledgerApproved = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "tf-apply", gate: "tf-apply-wave-1", resolvedBy: "alice", timestamp: NOW, planDigest: prodSet }] });
    const asker = stubAsker();
    const logs: string[] = [];
    const viaLedger = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: added.cwd, exec: added.exec, show: added.show, gates: ledgerApproved, points: asker, now: NOW, log: (l) => logs.push(l) });
    expect(viaLedger).toMatchObject({ exitCode: 0, decision: { status: "approved", via: "ledger" } });
    expect(asker.asked).toHaveLength(0);
    expect(logs.some((l) => l.includes("the one at base holds"))).toBe(true);
    added.done();

    // The change drops the point the base has: the point still decides.
    const dropped = harness(spec);
    const still = await runOpWave({ spec: bare, specFile: "waves.json", wave: 1, cwd: dropped.cwd, exec: dropped.exec, show: dropped.show, gates: ledgerApproved, points: asker, now: NOW, log: () => {} });
    expect(still.exitCode).toBe(3);
    expect(asker.asked).toHaveLength(1);
    dropped.done();

    // A wave's own point wins over the spec's.
    const own: OpWavesSpec = { ...spec, waves: [{ ...spec.waves[0]!, point: { name: "db-apply", pass: ["apply"] } }, spec.waves[1]!] };
    const mine = harness(own);
    const ownAsker = stubAsker(new Map([[prodSet, { state: "answered", answer: "apply", answeredBy: ["carol"] }]]));
    expect(await runOpWave({ spec: own, specFile: "waves.json", wave: 1, cwd: mine.cwd, exec: mine.exec, show: mine.show, gates: memoryGateLedgerPort(), points: ownAsker, now: NOW, log: () => {} })).toMatchObject({
      exitCode: 0,
      decision: { via: "point", approvedBy: "carol" },
    });
    expect(ownAsker.asked[0]!.point).toBe("db-apply");
    mine.done();

    // A point at base no gate could ask fails the wave rather than fall back to the ledger.
    const broken = harness({ ...spec, point: { name: "Not A Point" } });
    const failed = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: broken.cwd, exec: broken.exec, show: broken.show, gates: ledgerApproved, points: asker, now: NOW, log: () => {} });
    expect(failed.exitCode).toBe(1);
    expect(broken.calls).toEqual([]);
    broken.done();
  });

  test("a policy that lets the wave through asks nothing", async () => {
    const free: OpWavesSpec = { ...spec, waves: [{ ...spec.waves[0]!, gate: "never" }, spec.waves[1]!] };
    const h = harness(free);
    const asker = stubAsker();
    expect(await runOpWave({ spec: free, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), points: asker, log: () => {} })).toMatchObject({
      exitCode: 0,
      decision: { status: "not-required" },
    });
    expect(asker.asked).toHaveLength(0);
    h.done();
  });

  test("the plans file's pending fields and the spec's neverOverMcp land on the point gate's pending fact (#3863)", async () => {
    const tg: OpWavesSpec = {
      name: "tf-apply",
      op: "tf-apply",
      gateName: "wave-{k}",
      planWave: ["tg", "plan", "{wave}", "{runs}", "{plans}"],
      applyWave: ["tg", "apply", "{wave}", "{runs}", "{plans}"],
      point: { name: "prod-apply" },
      waves: [{ name: "net", runs: [{ target: "vpc" }, { target: "nat" }] }],
    };
    const members = [{ member: "vpc", planDigest: digest("1") }, { member: "nat", planDigest: digest("2") }];
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-point-3863-"));
    const exec: OpWaveExec = (argv, dir) => {
      const runs = JSON.parse(readFileSync(join(dir, argv[3]!), "utf-8")) as OpWaveRunsFile;
      if (argv[1] === "plan") {
        writeFileSync(join(dir, argv[4]!), JSON.stringify({
          runs: runs.runs.map((r) => ({ target: r.target, planDigest: members.find((m) => m.member === r.target)!.planDigest })),
          pending: { commit: "c".repeat(40), members, description: "wave 1 of 1: vpc, nat" },
        }));
      }
      return 0;
    };
    // neverOverMcp at base counts even when the change drops it.
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify({ ...tg, neverOverMcp: true }) });
    const gates = memoryGateLedgerPort();
    const asker = stubAsker();
    const waiting = await runOpWave({ spec: tg, specFile: "waves.json", wave: 1, cwd, exec, show, gates, points: asker, now: NOW, log: () => {} });
    expect(waiting.exitCode).toBe(3);
    expect(gates.appended).toHaveLength(1);
    expect(gates.appended[0]).toMatchObject({
      op: "tf-apply",
      gate: "wave-1",
      commit: "c".repeat(40),
      members,
      description: "wave 1 of 1: vpc, nat",
      neverOverMcp: true,
      answer: { point: "prod-apply" },
    });
    expect(waiting.decision?.pendingFact).toMatchObject({ commit: "c".repeat(40), neverOverMcp: true });

    // A standing fact for the same question that does not carry neverOverMcp does not stand: the run records one that does.
    const old = { ...gates.appended[0]! };
    delete (old as { neverOverMcp?: true }).neverOverMcp;
    const stale = memoryGateLedgerPort({ pending: [old] });
    await runOpWave({ spec: tg, specFile: "waves.json", wave: 1, cwd, exec, show, gates: stale, points: asker, now: NOW, log: () => {} });
    expect(stale.appended).toHaveLength(1);
    expect(stale.appended[0]).toMatchObject({ neverOverMcp: true });

    // Without neverOverMcp at base, the fact carries the fields and no neverOverMcp.
    const plain = memoryGateLedgerPort();
    await runOpWave({ spec: tg, specFile: "waves.json", wave: 1, cwd, exec, show: () => ({ sha: "b".repeat(40), text: JSON.stringify(tg) }), gates: plain, points: asker, now: NOW, log: () => {} });
    expect(plain.appended[0]).toMatchObject({ commit: "c".repeat(40), members });
    expect(plain.appended[0]).not.toHaveProperty("neverOverMcp");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("resume picks up the waiting wave once its question is answered (#3835)", async () => {
    vi.stubEnv("GITLAB_CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_REPOSITORY", "acme/infra");
    vi.stubEnv("GITHUB_RUN_ID", "4242");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    vi.stubEnv("FORGEJO_ACTIONS", "");
    vi.stubEnv("GITEA_ACTIONS", "");
    const h = harness();
    const gates = memoryGateLedgerPort();
    const waiting = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates, points: stubAsker(), now: NOW, log: () => {} });
    expect(waiting.exitCode).toBe(3);
    const fact = gates.appended[0]!;
    expect(fact.resume).toMatchObject({ forge: "github", repo: "acme/infra", run: "4242" });
    const id = fact.answer!.id;

    const open = { id, state: "escalated" as const, answer: null, answeredBy: [], answeredOn: null };
    expect(pointGateResumable(fact, open)).toMatchObject({ resumable: false, why: "open" });
    expect(await resumeStanding(fact, [], { questions: new Map([[id, open]]), dryRun: true })).toMatchObject({ status: "not-approved" });

    const no = { ...open, state: "answered" as const, answer: false, answeredBy: ["bob"], answeredOn: NOW };
    expect(pointGateResumable(fact, no)).toMatchObject({ resumable: false, why: "refused" });

    const yes = { ...open, state: "answered" as const, answer: true, answeredBy: ["alice"], answeredOn: NOW };
    expect(await resumeStanding(fact, [], { questions: new Map([[id, yes]]), dryRun: true })).toMatchObject({
      op: "tf-apply",
      gate: "tf-apply-wave-1",
      status: "would-resume",
      resumable: true,
      reason: "answered",
      approvedBy: "alice",
      message: expect.stringContaining("would resume github run 4242"),
    });
    h.done();
  });
});
