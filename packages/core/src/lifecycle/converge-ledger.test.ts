import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendConvergeRecord,
  readConvergeLedger,
  consecutiveRuleFires,
  type ConvergeTickRecordInput,
  type ConvergeTickRecord,
} from "./converge-ledger";

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
});
