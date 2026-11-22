/**
 * What waits for approval in an environment (#5480): the standing facts of a
 * member's ledgers that an approval in one environment answers, by kind.
 */
import { describe, expect, test } from "vitest";
import { pendingApprovalsIn, PENDING_APPROVALS_FLOOR, type PendingApprovalsLedger } from "./pending-approvals";
import type { GateResolutionRecord, PendingGateRecord } from "./gate-ledger";

const NOW = "2026-11-22T12:00:00.000Z";
const LATER = "2026-11-23T12:00:00.000Z";
const d = (c: string) => `jcs1-sha256:${c.repeat(64)}`;

function pending(fields: Partial<PendingGateRecord> & { op: string; gate: string }): PendingGateRecord {
  return { version: 1, kind: "pending", timestamp: "2026-11-22T10:00:00.000Z", expiresAt: LATER, ...fields };
}

function ledger(op: string, facts: PendingGateRecord[], resolutions: GateResolutionRecord[] = []): PendingApprovalsLedger {
  return { op, pending: facts, resolutions };
}

const waveFact = pending({ op: "waves", gate: "waves-wave-2", planDigest: d("a"), wave: { number: 2, name: "prod", op: "waves", environment: "prod" } });
const stagingWave = pending({ op: "waves", gate: "waves-wave-1", planDigest: d("9"), wave: { number: 1, name: "staging", op: "waves", environment: "staging" } });
const stageFact = pending({ op: "orders", gate: "prod", planDigest: d("b"), environment: "prod", timestamp: "2026-11-22T11:00:00.000Z" });
const componentFact = pending({ op: "api", gate: "deploy-ok", planDigest: d("c"), environment: "prod" });
const migrateFact = pending({ op: "migrate", gate: "migrate-gate", planDigest: d("e") });

describe("pendingApprovalsIn", () => {
  test("the floor names the next release", () => {
    expect(PENDING_APPROVALS_FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("an op wave's gate waits in the environment its fact names", () => {
    const got = pendingApprovalsIn([ledger("waves", [waveFact, stagingWave])], { env: "prod", now: NOW });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "wave", op: "waves", gate: "waves-wave-2", digest: d("a") });
    expect(got[0]!.approve).toEqual(["chant", "approve", "waves", "waves-wave-2", "--plan", d("a")]);
  });

  test("a stage's op waves wait in the stage, by the op the pipeline names them under", () => {
    const old = pending({ op: "orders-prod", gate: "orders-prod-wave-1", planDigest: d("f") });
    const got = pendingApprovalsIn([ledger("orders-prod", [old])], { env: "prod", pipeline: "orders", now: NOW });
    expect(got.map((g) => g.kind)).toEqual(["wave"]);
  });

  test("a pipeline stage's gate is found by the release digest it binds", () => {
    const got = pendingApprovalsIn([ledger("waves", [waveFact]), ledger("orders", [stageFact])], { env: "prod", plan: d("b"), pipeline: "orders", now: NOW });
    expect(got).toEqual([
      expect.objectContaining({ kind: "stage", op: "orders", gate: "prod", digest: d("b"), environment: "prod", matched: "planDigest", approve: ["chant", "approve", "orders", "prod", "--plan", d("b"), "--env", "prod"] }),
    ]);
  });

  test("a release gate matches its release digest too", () => {
    const release = pending({ op: "release-gate", gate: "deploy-ok", planDigest: d("1"), releaseDigest: d("2"), environment: "prod" });
    const got = pendingApprovalsIn([ledger("release-gate", [release])], { env: "prod", plan: d("2"), now: NOW });
    expect(got).toEqual([expect.objectContaining({ kind: "component", matched: "releaseDigest", digest: d("1") })]);
  });

  test("a component's gate waits in its environment and not in another", () => {
    const staging = pending({ op: "api", gate: "deploy-ok", planDigest: d("d"), environment: "staging" });
    const got = pendingApprovalsIn([ledger("api", [componentFact, staging])], { env: "prod", now: NOW });
    expect(got).toEqual([expect.objectContaining({ kind: "component", op: "api", gate: "deploy-ok", digest: d("c"), environment: "prod" })]);
  });

  test("an Op's gate with no environment counts only on a ledger the caller names", () => {
    const ledgers = [ledger("migrate", [migrateFact])];
    expect(pendingApprovalsIn(ledgers, { env: "prod", now: NOW })).toEqual([]);
    expect(pendingApprovalsIn(ledgers, { env: "prod", ops: ["migrate"], now: NOW })).toEqual([expect.objectContaining({ kind: "op", gate: "migrate-gate" })]);
  });

  test("a digest that matches no fact finds nothing", () => {
    const ledgers = [ledger("waves", [waveFact]), ledger("orders", [stageFact]), ledger("api", [componentFact])];
    expect(pendingApprovalsIn(ledgers, { env: "prod", plan: d("0"), pipeline: "orders", now: NOW })).toEqual([]);
  });

  test("two waiting at once are both listed, newest first, and a digest picks one", () => {
    const ledgers = [ledger("waves", [waveFact]), ledger("orders", [stageFact])];
    const all = pendingApprovalsIn(ledgers, { env: "prod", pipeline: "orders", now: NOW });
    expect(all.map((g) => `${g.kind} ${g.op}/${g.gate}`)).toEqual(["stage orders/prod", "wave waves/waves-wave-2"]);
    expect(pendingApprovalsIn(ledgers, { env: "prod", plan: d("a"), pipeline: "orders", now: NOW }).map((g) => g.kind)).toEqual(["wave"]);
  });

  test("an approved, expired, override or decision point fact does not wait", () => {
    const approved: GateResolutionRecord = { version: 1, kind: "resolution", op: "api", gate: "deploy-ok", resolvedBy: "someone", timestamp: "2026-11-22T11:30:00.000Z", environment: "prod" } as GateResolutionRecord;
    const expired = pending({ op: "orders", gate: "prod", planDigest: d("b"), environment: "prod", expiresAt: "2026-11-22T11:00:00.000Z" });
    const override = pending({ op: "policy-override", gate: "prod", planDigest: d("b"), environment: "prod" });
    const point = pending({ op: "orders", gate: "prod-soak", planDigest: d("b"), environment: "prod", answer: { id: "q1" } as PendingGateRecord["answer"] });
    const got = pendingApprovalsIn(
      [ledger("api", [componentFact], [approved]), ledger("orders", [expired, point]), ledger("policy-override", [override])],
      { env: "prod", pipeline: "orders", now: NOW },
    );
    expect(got).toEqual([]);
  });
});
