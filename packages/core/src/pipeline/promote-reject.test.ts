/**
 * #5354: a release rejected at a stage's gate does not enter the stage. A
 * rejection takes the proof rules an approval of the same gate takes, under
 * each approval mode, and only a new release clears it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../op/gate";
import { gateRejections } from "../op/gate-reject";
import { GATE_REJECTION_NAMESPACE, gateRejectionPayload, parseGateRejections, type GateRejectionRecord } from "../lifecycle/gate-rejection";
import { gateSealPayload, GATE_SEAL_NAMESPACE, type GateSigners } from "../lifecycle/gate-seal";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import { emptyPolicy, parseAllowedSigners } from "../workspace/trust/policy";
import { hasSshKeygen } from "../workspace/trust/test-repo";
import { asPipelineSpec, type PipelineGate, type PipelineSpec } from "./spec";
import { pipelinePromoteGates, pipelineStageEntry, type PipelineGateProof } from "./promote";
import { memoryStageLogPort } from "../lifecycle/stage-log";
import type { GateApprovalSource } from "../op/op-waves";

const RELEASE = "sha256:" + "1".repeat(64);
const NEXT = "sha256:" + "2".repeat(64);
const now = new Date("2026-11-20T01:00:00.000Z");

function specWith(gate: PipelineGate): PipelineSpec {
  const wave = (target: string) => [{ name: target, runs: [{ target }] }];
  return asPipelineSpec({
    name: "shop",
    stages: [
      { name: "dev", waves: wave("dev"), gate: { policy: "never" } },
      { name: "staging", waves: wave("staging"), gate },
      { name: "prod", waves: wave("prod"), gate: { policy: "never" } },
    ],
  });
}

function rejection(over: Partial<GateRejectionRecord> = {}): GateRejectionRecord {
  return {
    version: 1,
    kind: "rejection",
    op: "shop",
    gate: "staging",
    rejectedBy: "alice",
    reason: "the migration locks the orders table",
    timestamp: "2026-11-20T00:30:00.000Z",
    planDigest: RELEASE,
    environment: "staging",
    releaseDigest: RELEASE,
    approver: { kind: "human" },
    ...over,
  };
}

function approval(resolvedBy: string, over: Partial<GateResolutionRecord> = {}): GateResolutionRecord {
  // A stage's gate binds the release's digest as its plan, as `chant approve` copies it off the pending fact.
  return { version: 1, op: "shop", gate: "staging", resolvedBy, timestamp: "2026-11-20T00:40:00.000Z", planDigest: RELEASE, environment: "staging", ...over };
}

const NO_SIGNERS: PipelineGateProof = { signers: emptyPolicy(null) as GateSigners, roles: {} };

async function promote(gate: PipelineGate, seed: Parameters<typeof memoryGateLedgerPort>[0], proof: PipelineGateProof = NO_SIGNERS, digest = RELEASE) {
  const spec = specWith(gate);
  return pipelinePromoteGates({ spec, to: "staging", skipped: [], digest, releaseDigest: digest, port: memoryGateLedgerPort(seed), now, proof });
}

const MODES: GateApprovalSource[] = ["ledger", "pr-review", "pull-request", "sealed"];

describe("a plain rejection, under each approval mode", () => {
  test.each(MODES.filter((m) => m !== "sealed"))("under %s it stops the release, which no approval then clears", async (mode) => {
    const out = await promote({ approval: mode }, { rejections: [rejection()], resolutions: [approval("bob"), approval("carol")] });
    expect(out).toMatchObject({ passed: false, exitCode: 8, code: "pipeline-release-rejected" });
    if (!out.passed) {
      expect(out.message).toContain(`release ${RELEASE} was rejected at shop staging`);
      expect(out.message).toContain("rejected by alice at 2026-11-20T00:30:00.000Z: the migration locks the orders table");
    }
  });

  test("under sealed it does not count, and the run says why", async () => {
    const out = await promote({ approval: "sealed" }, { rejections: [rejection()] });
    expect(out).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-gate-waiting" });
    expect(out.lines?.[0]).toMatch(/the rejection by alice does not count: gate staging counts only sealed approvals, so it counts only a sealed rejection/);
  });

  test("a rejection stops the stage even when its gate never waits", async () => {
    await expect(promote({ policy: "never" }, { rejections: [rejection()] })).resolves.toMatchObject({ passed: false, exitCode: 8 });
  });

  test("an agent's rejection counts for nothing, as an agent's approval does", async () => {
    const out = await promote({}, { rejections: [rejection({ approver: { kind: "agent" } })], resolutions: [approval("bob")] });
    expect(out).toMatchObject({ passed: true });
    expect(out.lines?.[0]).toContain("is an agent");
  });
});

describe("a new release clears a rejection; approvals never do", () => {
  test("the next release goes through the gate on its own approval", async () => {
    const seed = { rejections: [rejection()], resolutions: [approval("bob", { planDigest: NEXT })] };
    await expect(promote({}, seed)).resolves.toMatchObject({ passed: false, exitCode: 8 });
    await expect(promote({}, seed, NO_SIGNERS, NEXT)).resolves.toMatchObject({ passed: true, lines: ["stage staging: shop staging approved by bob"] });
  });

  test("a rejection of another stage's gate, or of another release, does not stop this one", async () => {
    const records = [rejection({ gate: "prod", environment: "prod" }), rejection({ planDigest: NEXT, releaseDigest: NEXT })];
    await expect(promote({}, { rejections: records, resolutions: [approval("bob")] })).resolves.toMatchObject({ passed: true });
  });

  test("a release rejected at a stage is not skipped past it", async () => {
    const spec = specWith({});
    const port = memoryGateLedgerPort({ rejections: [rejection()], resolutions: [approval("bob", { gate: "staging-skip" })] });
    const out = await pipelinePromoteGates({ spec, to: "prod", skipped: [spec.stages[1]!], digest: RELEASE, releaseDigest: RELEASE, port, now, proof: NO_SIGNERS });
    expect(out).toMatchObject({ passed: false, exitCode: 8, code: "pipeline-release-rejected" });
    expect(port.applied).toEqual([]);
  });
});

describe("a stage that takes one release at a time (#5353)", () => {
  test("a rejected release does not enter it, and no entered line is written", async () => {
    const wave = (target: string) => [{ name: target, runs: [{ target }] }];
    const spec = asPipelineSpec({ name: "shop", stages: [{ name: "dev", waves: wave("dev") }, { name: "staging", waves: wave("staging"), queue: "replace", gate: { approval: "sealed" } }] });
    const log = memoryStageLogPort();
    const out = await pipelineStageEntry({ spec, to: "staging", skipped: [], digest: RELEASE, release: { releaseDigest: RELEASE, commit: "c".repeat(40) }, port: memoryGateLedgerPort({ rejections: [rejection()] }), log, now, proof: NO_SIGNERS });
    // Under sealed a plain rejection does not count, so the gate waits; the proof reached the gate.
    expect(out).toMatchObject({ passed: false, exitCode: 3 });
    expect(out.lines?.[0]).toMatch(/counts only a sealed rejection/);
    const plain = asPipelineSpec({ ...spec, stages: spec.stages.map((s) => (s.name === "staging" ? { ...s, gate: {} } : s)) });
    const stopped = await pipelineStageEntry({ spec: plain, to: "staging", skipped: [], digest: RELEASE, release: { releaseDigest: RELEASE, commit: "c".repeat(40) }, port: memoryGateLedgerPort({ rejections: [rejection()] }), log: memoryStageLogPort(), now, proof: NO_SIGNERS });
    expect(stopped).toMatchObject({ passed: false, exitCode: 8, code: "pipeline-release-rejected" });
  });
});

describe("rejection lines on the ledger", () => {
  test("parse back, and a line that is not a rejection is skipped", () => {
    const text = [JSON.stringify(rejection()), JSON.stringify({ version: 1, kind: "applied", op: "shop" }), "not json", JSON.stringify({ ...rejection(), reason: "" })].join("\n");
    expect(parseGateRejections(text)).toEqual([rejection()]);
  });
});

const dir = mkdtempSync(join(tmpdir(), "chant-5354-reject-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function key(name: string): { file: string; pub: string } {
  const file = join(dir, `key-${name}`);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file]);
  return { file, pub: readFileSync(`${file}.pub`, "utf-8").trim().split(" ").slice(0, 2).join(" ") };
}

function sign(k: { file: string }, payload: Buffer, namespace: string): string {
  const f = join(dir, `payload-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, payload);
  execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-n", namespace, "-f", k.file, f], { stdio: "ignore" });
  return readFileSync(`${f}.sig`, "utf-8");
}

describe.skipIf(!hasSshKeygen)("a sealed rejection", () => {
  const alice = hasSshKeygen ? key("alice") : { file: "", pub: "" };
  const proof = (): PipelineGateProof => {
    const set = parseAllowedSigners(`alice ${alice.pub}\n`);
    return { signers: { ...emptyPolicy("0".repeat(40)), active: true, signers: set.signers } as GateSigners, roles: { "release-manager": ["alice"] } };
  };
  const sealed = (over: Partial<GateRejectionRecord> = {}, namespace = GATE_REJECTION_NAMESPACE): GateRejectionRecord => {
    const r = rejection(over);
    return { ...r, seal: { signer: "alice", key: "k", signature: sign(alice, gateRejectionPayload(r), namespace) } };
  };

  test.each(MODES)("under %s it stops the release", async (mode) => {
    await expect(promote({ approval: mode }, { rejections: [sealed()] }, proof())).resolves.toMatchObject({ passed: false, exitCode: 8 });
  });

  test("an approval's seal can't stand in for a rejection's, nor a seal over an edited reason", async () => {
    const r = rejection();
    const asApproval = { ...r, seal: { signer: "alice", key: "k", signature: sign(alice, gateSealPayload({ op: "shop", gate: "staging", environment: "staging", planDigest: RELEASE, resolvedBy: "alice", timestamp: r.timestamp }), GATE_SEAL_NAMESPACE) } };
    const edited = { ...sealed(), reason: "something else" };
    const found = gateRejections([asApproval, edited], { gate: "staging", planDigest: RELEASE, environment: "staging", releaseDigest: RELEASE, mode: "sealed", signers: proof().signers, roles: {} });
    expect(found.standing).toEqual([]);
    expect(found.ignored.map((i) => i.why)).toEqual([expect.stringMatching(/does not verify for alice/), expect.stringMatching(/does not verify for alice/)]);
  });

  test("a gate whose rule counts a role counts a rejection only from someone holding it", async () => {
    const rm: PipelineGate = { quorum: [{ name: "release-manager", count: 1, roles: ["release-manager"] }] };
    await expect(promote(rm, { rejections: [sealed()] }, proof())).resolves.toMatchObject({ passed: false, exitCode: 8 });
    const without = await promote(rm, { rejections: [sealed()] }, { ...proof(), roles: {} });
    expect(without).toMatchObject({ passed: false, exitCode: 3 });
    expect(without.lines?.[0]).toMatch(/no approval rule of gate staging counts alice: .chant\/trust.json at base gives them none of release-manager/);
  });

  test("a gate whose rules all need proof counts a sealed rejection, and no plain one", async () => {
    const gate: PipelineGate = { quorum: [{ any: [{ count: 2, proven: true }, { name: "release-manager", count: 1, roles: ["release-manager"] }] }] };
    await expect(promote(gate, { rejections: [sealed()] }, proof())).resolves.toMatchObject({ passed: false, exitCode: 8 });
    const noRole = { ...proof(), roles: {} };
    // Alice is proven, so the `count: 2, proven` rule would count her: her rejection stands.
    await expect(promote(gate, { rejections: [sealed()] }, noRole)).resolves.toMatchObject({ passed: false, exitCode: 8 });
    // A plain rejection is proven by nothing, and every rule needs proof.
    const plain = await promote(gate, { rejections: [rejection()] }, proof());
    expect(plain).toMatchObject({ passed: false, exitCode: 3 });
    expect(plain.lines?.[0]).toMatch(/every approval rule of gate staging counts only a proven approver/);
  });

  test("under sealed, an unsealed approval no longer passes the stage, and a sealed one does", async () => {
    const r = approval("alice");
    const sig = sign(alice, gateSealPayload({ op: r.op, gate: r.gate, environment: r.environment!, planDigest: r.planDigest!, resolvedBy: "alice", timestamp: r.timestamp }), GATE_SEAL_NAMESPACE);
    await expect(promote({ approval: "sealed" }, { resolutions: [approval("bob")] }, proof())).resolves.toMatchObject({ passed: false, exitCode: 3, hint: expect.stringContaining("--sign") });
    await expect(promote({ approval: "sealed" }, { resolutions: [{ ...r, seal: { signer: "alice", key: "k", signature: sig } }] }, proof())).resolves.toMatchObject({ passed: true });
  });
});
