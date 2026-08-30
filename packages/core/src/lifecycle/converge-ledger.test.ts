import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendConvergeRecord,
  readConvergeLedger,
  consecutiveRuleFires,
  componentVerdicts,
  type ConvergeTickRecordInput,
  type ConvergeTickRecord,
} from "./converge-ledger";
import type { ComponentStatusRow } from "./status";

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

function makeInput(overrides?: Partial<ConvergeTickRecordInput>): ConvergeTickRecordInput {
  return {
    op: "fountain-converge",
    env: "staging",
    timestamp: "2026-01-01T00:00:00.000Z",
    firedRuleIds: [],
    outcomes: [],
    summary: { drifted: 0, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0 },
    log: "converge(staging): drifted=0 remediated=0 reported=0 skipped-budget=0 skipped-flap=0 unobserved=0 adopted=0",
    ...overrides,
  };
}

describe("converge-ledger", () => {
  describe("appendConvergeRecord / readConvergeLedger", () => {
    test("round-trips a single record", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const { record } = await appendConvergeRecord(makeInput(), { cwd: dir });
        expect(record.version).toBe(1);

        const { records, malformed } = await readConvergeLedger("staging", { cwd: dir });
        expect(malformed).toBe(0);
        expect(records).toEqual([record]);
      });
    });

    test("appends without clobbering prior records", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await appendConvergeRecord(makeInput({ timestamp: "2026-01-01T00:00:00.000Z" }), { cwd: dir });
        await appendConvergeRecord(makeInput({ timestamp: "2026-01-01T00:10:00.000Z" }), { cwd: dir });
        await appendConvergeRecord(makeInput({ timestamp: "2026-01-01T00:20:00.000Z" }), { cwd: dir });

        const { records } = await readConvergeLedger("staging", { cwd: dir });
        expect(records).toHaveLength(3);
        expect(records.map((r) => r.timestamp)).toEqual([
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:10:00.000Z",
          "2026-01-01T00:20:00.000Z",
        ]);
      });
    });

    test("empty ledger for an environment with no records — never throws", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const { records, malformed } = await readConvergeLedger("nowhere", { cwd: dir });
        expect(records).toEqual([]);
        expect(malformed).toBe(0);
      });
    });

    test("skips malformed lines but reports the count", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await appendConvergeRecord(makeInput(), { cwd: dir });
        // Directly corrupt the ledger by writing a second, non-JSON line via a
        // second append whose "record" is actually malformed content — simulate
        // by reading, then re-appending raw garbage through the same git path
        // a hand-edited ledger would produce. We reuse appendConvergeRecord's
        // underlying git plumbing indirectly by writing a second valid record,
        // then asserting the reader tolerates an out-of-schema line mixed in
        // at read time isn't directly expressible via the public API, so this
        // test instead exercises the schema-validation branch: a record
        // missing `firedRuleIds` is treated as malformed.
        const { readBlobFromPath, writeBlobToPath } = await import("./git");
        const existing = await readBlobFromPath("staging", "converge.jsonl", { cwd: dir });
        const corrupted = `${existing}\n${JSON.stringify({ version: 1, op: "x", env: "staging" })}`;
        await writeBlobToPath("staging", "converge.jsonl", corrupted, "corrupt", { cwd: dir });

        const { records, malformed } = await readConvergeLedger("staging", { cwd: dir });
        expect(records).toHaveLength(1);
        expect(malformed).toBe(1);
      });
    });
  });

  describe("consecutiveRuleFires", () => {
    function rec(firedRuleIds: string[]): ConvergeTickRecord {
      return { ...makeInput({ firedRuleIds }), version: 1 };
    }

    test("0 for an empty ledger", () => {
      expect(consecutiveRuleFires([], "r1")).toBe(0);
    });

    test("0 when the newest tick didn't fire it", () => {
      const records = [rec(["r1"]), rec(["r1"]), rec([])];
      expect(consecutiveRuleFires(records, "r1")).toBe(0);
    });

    test("counts consecutive fires from the newest tick backward", () => {
      const records = [rec([]), rec(["r1"]), rec(["r1"]), rec(["r1"])];
      expect(consecutiveRuleFires(records, "r1")).toBe(3);
    });

    test("stops counting at the first non-firing tick, scanning backward", () => {
      const records = [rec(["r1"]), rec([]), rec(["r1"]), rec(["r1"])];
      expect(consecutiveRuleFires(records, "r1")).toBe(2);
    });

    test("only counts the named rule, ignoring others", () => {
      const records = [rec(["r2"]), rec(["r1", "r2"])];
      expect(consecutiveRuleFires(records, "r1")).toBe(1);
      expect(consecutiveRuleFires(records, "r2")).toBe(2);
    });
  });

  // ── Gate-as-fact (#1485) ───────────────────────────────────────────────────

  describe("gated outcome", () => {
    test("round-trips a 'gated' outcome with its gateName, and a gated count in the summary", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const { record } = await appendConvergeRecord(
          makeInput({
            firedRuleIds: ["drift-apply"],
            outcomes: [
              {
                ruleId: "drift-apply",
                action: "gated",
                op: "fountain-apply",
                gateName: "rollout-gate",
                reason: 'dispatch of "fountain-apply" hit gate "rollout-gate"',
              },
            ],
            summary: { drifted: 1, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0, gated: 1 },
          }),
          { cwd: dir },
        );
        expect(record.outcomes[0]).toEqual({
          ruleId: "drift-apply",
          action: "gated",
          op: "fountain-apply",
          gateName: "rollout-gate",
          reason: 'dispatch of "fountain-apply" hit gate "rollout-gate"',
        });
        expect(record.summary.gated).toBe(1);

        const { records } = await readConvergeLedger("staging", { cwd: dir });
        expect(records).toEqual([record]);
      });
    });
  });

  // ── Per-component verdicts and tick id (#2027) ─────────────────────────────

  describe("tick id", () => {
    test("mints one per record, and two ticks in the same ISO second are still distinguishable", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const a = await appendConvergeRecord(makeInput(), { cwd: dir });
        const b = await appendConvergeRecord(makeInput(), { cwd: dir });

        expect(a.record.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(a.record.timestamp).toBe(b.record.timestamp);
        expect(a.record.id).not.toBe(b.record.id);

        const { records } = await readConvergeLedger("staging", { cwd: dir });
        expect(records.map((r) => r.id)).toEqual([a.record.id, b.record.id]);
      });
    });

    test("an explicitly supplied id wins over the mint", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const { record } = await appendConvergeRecord(makeInput({ id: "tick-fixed" }), { cwd: dir });
        expect(record.id).toBe("tick-fixed");
      });
    });

    test("a pre-#2027 record with no id still reads, rather than being counted malformed", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await appendConvergeRecord(makeInput(), { cwd: dir });
        // Hand-write the pre-#2027 shape (no `id`) onto the same ledger,
        // through the same git plumbing a real writer used before the field
        // existed.
        const { readBlobFromPath, writeBlobToPath } = await import("./git");
        const legacy = JSON.stringify({ version: 1, ...makeInput({ timestamp: "2025-12-31T00:00:00.000Z" }) });
        const existing = await readBlobFromPath("staging", "converge.jsonl", { cwd: dir });
        await writeBlobToPath("staging", "converge.jsonl", `${existing}\n${legacy}`, "legacy", { cwd: dir });

        const { records, malformed } = await readConvergeLedger("staging", { cwd: dir });
        expect(malformed).toBe(0);
        expect(records).toHaveLength(2);
        expect(records[1].id).toBeUndefined();
      });
    });
  });

  describe("componentVerdicts", () => {
    const row = (over: Partial<ComponentStatusRow>): ComponentStatusRow => ({
      component: "svc",
      env: "staging",
      reconciliation: "reconciled",
      detail: "digest matches live",
      ...over,
    } as ComponentStatusRow);

    test("keeps the verdict-bearing subset and drops the heavy release/build fields", () => {
      const rows = [
        row({ component: "api", reconciliation: "drifted", detail: "live digest differs", live: true,
              recorded: { version: 1 } as unknown as ComponentStatusRow["recorded"] }),
        row({ component: "worker", reconciliation: "unknown", detail: "could not read live state",
              unobserved: { reason: "no-credentials", detail: "no role assumed" } }),
      ];
      expect(componentVerdicts(rows)).toEqual([
        { component: "api", reconciliation: "drifted", detail: "live digest differs", live: true },
        {
          component: "worker",
          reconciliation: "unknown",
          detail: "could not read live state",
          unobserved: { reason: "no-credentials", detail: "no role assumed" },
        },
      ]);
    });

    test("caps a multi-line or oversized detail to one line, so the record stays one line of JSON", () => {
      const verdicts = componentVerdicts([
        row({ detail: "first line\nsecond line" }),
        row({ component: "big", detail: "x".repeat(500) }),
      ]);
      expect(verdicts[0].detail).toBe("first line");
      expect(verdicts[1].detail).toHaveLength(301); // 300 + the ellipsis
      expect(JSON.stringify(verdicts)).not.toContain("\\n");
    });

    test("round-trips on a record, naming the component that tripped the tick's aggregate unknown", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const { record } = await appendConvergeRecord(
          makeInput({
            components: componentVerdicts([
              row({ component: "api", reconciliation: "drifted", detail: "live digest differs", live: true }),
              row({ component: "worker", reconciliation: "unknown", detail: "unreadable",
                    unobserved: { reason: "no-credentials" } }),
            ]),
            summary: { drifted: 1, remediated: 0, reported: 1, skippedBudget: 0, skippedFlap: 0, unobserved: 1, adopted: 0 },
          }),
          { cwd: dir },
        );

        const { records } = await readConvergeLedger("staging", { cwd: dir });
        expect(records).toEqual([record]);
        // The count says "1 unobserved"; the verdicts say which one.
        expect(records[0].summary.unobserved).toBe(1);
        expect(records[0].components?.filter((c) => c.unobserved).map((c) => c.component)).toEqual(["worker"]);
        expect(records[0].components?.find((c) => c.reconciliation === "drifted")?.component).toBe("api");
      });
    });
  });

  // ── Concurrent local writers (#1485) ────────────────────────────────────────

  describe("appendConvergeRecord retries on RefCASConflictError", () => {
    test("a concurrent writer to a different env's file on the same orphan branch doesn't lose either write", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        // Two "operators" appending to two different environments' ledgers on
        // the same orphan branch, interleaved so their internal git-plumbing
        // reads race — this is exactly the scenario `writeBlobToPath`'s CAS
        // guard (chant #1485) now protects against, and `appendConvergeRecord`
        // retries through rather than surfacing to the caller.
        const [a, b] = await Promise.all([
          appendConvergeRecord(makeInput({ env: "staging", op: "staging-converge" }), { cwd: dir }),
          appendConvergeRecord(makeInput({ env: "prod", op: "prod-converge" }), { cwd: dir }),
        ]);
        expect(a.record.env).toBe("staging");
        expect(b.record.env).toBe("prod");

        const staging = await readConvergeLedger("staging", { cwd: dir });
        const prod = await readConvergeLedger("prod", { cwd: dir });
        expect(staging.records).toHaveLength(1);
        expect(prod.records).toHaveLength(1);
      });
    });
  });
});
