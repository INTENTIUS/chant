/**
 * A release gate (#4045, ws-104 question 2) binds the release, the
 * environment and the change-set document digest; an approval counts only
 * when all three match. An `empty` pass (question 6) counts only once the
 * stored document reads back empty. Decided against an in-memory ledger.
 */

import { describe, expect, test } from "vitest";
import { evaluateGate, memoryGateLedgerPort } from "./gate";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";

const sha = (c: string) => `jcs1-sha256:${c.repeat(64)}`;
const RELEASE_A = sha("a");
const RELEASE_B = sha("b");
const DOC = sha("d");
const NOW = "2026-10-16T12:00:00.000Z";
const LATER = "2026-10-16T13:00:00.000Z";

const gateInput = (over: Partial<Parameters<typeof evaluateGate>[1]> = {}) => ({
  op: "release",
  gate: "prod-release",
  environment: "prod",
  planDigest: DOC,
  releaseDigest: RELEASE_A,
  now: NOW,
  ...over,
});

const approval = (over: Partial<GateResolutionRecord> = {}): GateResolutionRecord => ({
  version: 1,
  op: "release",
  gate: "prod-release",
  resolvedBy: "alice",
  timestamp: "2026-10-16T12:30:00.000Z",
  planDigest: DOC,
  environment: "prod",
  releaseDigest: RELEASE_A,
  ...over,
});

describe("a release gate binds the release, the environment and the change set", () => {
  test("the pending fact names the release it waits on", async () => {
    const port = memoryGateLedgerPort();
    const check = await evaluateGate(port, gateInput());
    expect(check.satisfied).toBe(false);
    expect(port.appended[0]).toMatchObject({ op: "release", gate: "prod-release", environment: "prod", planDigest: DOC, releaseDigest: RELEASE_A });
  });

  test("an approval for the release, environment and change set passes, and names the release it admitted", async () => {
    const port = memoryGateLedgerPort({ resolutions: [approval()] });
    const check = await evaluateGate(port, gateInput({ now: LATER }));
    expect(check.satisfied).toBe(true);
    if (check.satisfied) expect(check.resolution.releaseDigest).toBe(RELEASE_A);
  });

  test("an approval for one release can't be used by another, even for the same change-set digest", async () => {
    const port = memoryGateLedgerPort({ resolutions: [approval()] });
    const check = await evaluateGate(port, gateInput({ releaseDigest: RELEASE_B, now: LATER }));
    expect(check.satisfied).toBe(false);
    if (!check.satisfied) {
      expect(check.mismatch).toMatchObject({ resolvedBy: "alice", approved: DOC, planned: DOC, environment: "prod" });
      expect(check.pending.releaseDigest).toBe(RELEASE_B);
    }
  });

  test("an approval for one environment can't be used for another", async () => {
    const port = memoryGateLedgerPort({ resolutions: [approval({ environment: "staging" })] });
    const check = await evaluateGate(port, gateInput({ now: LATER }));
    expect(check.satisfied).toBe(false);
    if (!check.satisfied) expect(check.pending.environment).toBe("prod");
  });

  test("an approval for another change set of the same release doesn't pass", async () => {
    const port = memoryGateLedgerPort({ resolutions: [approval({ planDigest: sha("e") })] });
    const check = await evaluateGate(port, gateInput({ now: LATER }));
    expect(check.satisfied).toBe(false);
    if (!check.satisfied) expect(check.mismatch?.approved).toBe(sha("e"));
  });

  test("a gate that binds no release counts no approval recorded for one", async () => {
    const port = memoryGateLedgerPort({ resolutions: [approval()] });
    const check = await evaluateGate(port, gateInput({ releaseDigest: undefined, now: LATER }));
    expect(check.satisfied).toBe(false);
  });

  test("a standing fact for another release is recorded again for this one", async () => {
    const port = memoryGateLedgerPort();
    await evaluateGate(port, gateInput());
    const again = await evaluateGate(port, gateInput({ releaseDigest: RELEASE_B, now: "2026-10-16T12:01:00.000Z" }));
    expect(again.satisfied).toBe(false);
    if (!again.satisfied) expect(again.recorded).toBe(true);
    expect(port.appended.map((p) => p.releaseDigest)).toEqual([RELEASE_A, RELEASE_B]);
  });
});

describe("an empty pass", () => {
  const pass = approval({ resolvedBy: "bob", empty: true, timestamp: "2026-10-16T11:59:00.000Z" });

  test("passes the gate once the stored change set reads back empty", async () => {
    const asked: string[] = [];
    const port = memoryGateLedgerPort({ resolutions: [pass] });
    const check = await evaluateGate(port, gateInput({ verifyEmpty: async (d) => (asked.push(d), true) }));
    expect(check).toMatchObject({ satisfied: true, via: "empty", resolution: { resolvedBy: "bob", empty: true, releaseDigest: RELEASE_A } });
    expect(asked).toEqual([DOC]);
    expect(port.appended).toEqual([]);
  });

  test("doesn't pass when the stored change set is not empty", async () => {
    const port = memoryGateLedgerPort({ resolutions: [pass] });
    const check = await evaluateGate(port, gateInput({ verifyEmpty: async () => false }));
    expect(check.satisfied).toBe(false);
  });

  test("is never an approval: without a verifier, or on a gate without a plan, it counts for nothing", async () => {
    const port = memoryGateLedgerPort({ resolutions: [pass] });
    expect((await evaluateGate(port, gateInput())).satisfied).toBe(false);
    const plain = memoryGateLedgerPort({ resolutions: [{ ...pass, planDigest: undefined, releaseDigest: undefined }] });
    expect((await evaluateGate(plain, { op: "release", gate: "prod-release", now: NOW })).satisfied).toBe(false);
  });

  test("for another release it doesn't pass", async () => {
    const port = memoryGateLedgerPort({ resolutions: [pass] });
    const check = await evaluateGate(port, gateInput({ releaseDigest: RELEASE_B, verifyEmpty: async () => true }));
    expect(check.satisfied).toBe(false);
  });
});
