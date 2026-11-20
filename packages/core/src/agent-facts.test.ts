/**
 * The facts that start an agent job (#5329): signed with the relay key,
 * recorded once, read back and grouped per member inside the join window.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { AGENT_FACTS_DIR, parseAgentFacts, pendingAgentFacts, readAgentFacts, recordAgentFacts, signAgentFact, verifyAgentFact, type AgentFact, type UnsignedAgentFact } from "./agent-facts";
import { readBlobFromPath } from "./lifecycle/git";
import type { OpRunRecord } from "./op/runtime";

const KEY = "relay-key-for-tests";
const NOW = new Date("2026-11-19T12:00:00Z");
const MIN = 60_000;

const at = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * MIN).toISOString();

function fact(o: Partial<UnsignedAgentFact> & { key: string }, key = KEY): AgentFact {
  return signAgentFact(key, { trigger: "alert", member: "app", at: at(10), received: at(10), by: "plywood-relay", data: { source: "generic" }, ...o });
}

const runWith = (agent: Record<string, unknown>): Pick<OpRunRecord, "outcomes"> => ({ outcomes: { agent } });

describe("a fact's signature", () => {
  test("verifies with the relay key, and fails with another key or a changed field", () => {
    const f = fact({ key: "generic:1" });
    expect(f.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyAgentFact(KEY, f)).toBe(true);
    expect(verifyAgentFact("another-key", f)).toBe(false);
    expect(verifyAgentFact(undefined, f)).toBe(false);
    expect(verifyAgentFact(KEY, { ...f, member: "db" })).toBe(false);
    expect(verifyAgentFact(KEY, { ...f, data: { source: "generic", title: "rm everything" } })).toBe(false);
    expect(verifyAgentFact(KEY, { ...f, key: "generic:2" })).toBe(false);
  });

  test("a line that is not a fact is skipped and counted", () => {
    const f = fact({ key: "generic:1" });
    const { facts, malformed } = parseAgentFacts(`${JSON.stringify(f)}\nnot json\n{"v":2}\n`);
    expect(facts).toHaveLength(1);
    expect(malformed).toBe(2);
  });
});

describe("new facts", () => {
  const WINDOW = 15 * MIN;

  test("facts for one member close together are one group; another member's are their own", () => {
    const a = fact({ key: "a", received: at(20) });
    const b = fact({ key: "b", received: at(10) });
    const c = fact({ key: "c", received: at(1) });
    const d = fact({ key: "d", member: "db", received: at(9) });
    const { groups } = pendingAgentFacts({ facts: [c, d, b, a], runs: [], relayKey: KEY, now: NOW, windowMs: WINDOW });
    expect(groups.map((g) => [g.member, g.facts.map((f) => f.key)])).toEqual([
      ["app", ["a", "b"]],
      ["db", ["d"]],
      ["app", ["c"]],
    ]);
    expect(groups[0]!.window).toEqual({ from: a.received, until: new Date(Date.parse(a.received) + WINDOW).toISOString() });
  });

  test("a fact a run took, one inside a run's open window, a stale one and an unsigned one start nothing", () => {
    const taken = fact({ key: "taken", received: at(30) });
    const joined = fact({ key: "joined", received: at(5) });
    const stale = fact({ key: "stale", received: new Date(NOW.getTime() - 25 * 60 * MIN).toISOString() });
    const unsigned = fact({ key: "unsigned", received: at(2) }, "not-the-relay-key");
    const otherMember = fact({ key: "other", member: "db", received: at(5) });
    const runs = [runWith({ trigger: "alert", facts: [taken.id], member: "app", window: { from: at(10), until: at(-5) } })];
    const { groups, setAside } = pendingAgentFacts({ facts: [taken, joined, stale, unsigned, otherMember], runs, relayKey: KEY, now: NOW, windowMs: WINDOW });
    expect(groups.map((g) => g.facts.map((f) => f.key))).toEqual([["other"]]);
    expect(Object.fromEntries(setAside.map((s) => [s.id, s.reason]))).toEqual({ [taken.id]: "taken", [joined.id]: "joined", [stale.id]: "stale", [unsigned.id]: "unsigned" });
  });
});

function git(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8" });
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

describe("recording facts on the ledger", () => {
  test("a retried delivery, by the source's id or by its Idempotency-Key, is recorded once", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const first = fact({ key: "pagerduty:Q1", idempotencyKey: "delivery-1" });
      const out1 = await recordAgentFacts([first], { cwd: dir });
      expect(out1.recorded.map((f) => f.key)).toEqual(["pagerduty:Q1"]);
      const sameKey = fact({ key: "pagerduty:Q1", received: at(1) });
      const sameDelivery = fact({ key: "pagerduty:Q2", idempotencyKey: "delivery-1" });
      const fresh = fact({ key: "pagerduty:Q3" });
      const out2 = await recordAgentFacts([sameKey, sameDelivery, fresh, fresh], { cwd: dir });
      expect(out2.recorded.map((f) => f.key)).toEqual(["pagerduty:Q3"]);
      expect(out2.duplicates).toHaveLength(3);
      const back = await readAgentFacts("alert", { cwd: dir });
      expect(back.map((f) => f.key)).toEqual(["pagerduty:Q1", "pagerduty:Q3"]);
      expect(back.every((f) => verifyAgentFact(KEY, f))).toBe(true);
      expect(await readBlobFromPath(AGENT_FACTS_DIR, "alert.jsonl", { cwd: dir, ledgerPrefix: "" })).toContain('"trigger":"alert"');
    });
  });
});
