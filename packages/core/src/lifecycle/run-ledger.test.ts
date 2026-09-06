/**
 * Run ledger tests (#2118) — the same git fixture `converge-ledger.test.ts`
 * uses, so the two ledgers are exercised against one real orphan branch and a
 * change to the shared plumbing under them fails in both places.
 */
import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendRunRecord,
  readRunLedger,
  buildRunRecord,
  runEnvOf,
  DEFAULT_RUN_ENV,
} from "./run-ledger";
import type { OpRunRecordInput } from "../op/runtime";
import { appendConvergeRecord, readConvergeLedger } from "./converge-ledger";
import { runOpLocally, OpRunFailure } from "../op/local-executor";
import type { ActivityFn } from "../op/activity-registry";
import type { OpConfig } from "../op/types";

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

function makeInput(overrides?: Partial<OpRunRecordInput>): OpRunRecordInput {
  return {
    op: "alb-deploy",
    env: "staging",
    started: "2026-01-01T00:00:00.000Z",
    ended: "2026-01-01T00:00:12.000Z",
    status: "ok",
    labels: { Apply: "true", Env: "staging" },
    outcomes: {},
    phases: [{ name: "Apply", status: "ok", steps: [{ fn: "kubectlApply", status: "ok", durationMs: 12_000 }] }],
    ...overrides,
  };
}

const NO_PROFILES = {};

function opConfig(overrides?: Partial<OpConfig>): OpConfig {
  return {
    name: "alb-deploy",
    overview: "deploy the alb",
    labels: { Env: "staging" },
    phases: [{ name: "Apply", steps: [{ kind: "activity", fn: "ok", args: {} }] }],
    ...overrides,
  };
}

describe("runEnvOf", () => {
  test("reads labels.Env", () => {
    expect(runEnvOf({ labels: { Env: "prod" } })).toBe("prod");
  });

  test("falls back to the default env when the Op declares no labels", () => {
    expect(runEnvOf({})).toBe(DEFAULT_RUN_ENV);
    expect(runEnvOf({ labels: { Apply: "true" } })).toBe(DEFAULT_RUN_ENV);
  });
});

describe("buildRunRecord", () => {
  test("groups step records into phases in execution order and folds outcomes", () => {
    const input = buildRunRecord(
      { name: "watch", labels: { Watch: "true", Env: "prod" } },
      [
        { phase: "Snapshot", fn: "lifecycleSnapshot", status: "ok", durationMs: 5 },
        { phase: "Diff", fn: "lifecycleDiff", status: "ok", durationMs: 7, outcome: { name: "Drift", value: true } },
        { phase: "Diff", fn: "report", status: "skipped", durationMs: 0 },
      ],
      { started: "2026-01-01T00:00:00.000Z", ended: "2026-01-01T00:00:01.000Z", status: "ok" },
    );

    expect(input.env).toBe("prod");
    expect(input.status).toBe("ok");
    expect(input.labels).toEqual({ Watch: "true", Env: "prod" });
    expect(input.outcomes).toEqual({ Drift: true });
    expect(input.phases.map((p) => [p.name, p.status])).toEqual([["Snapshot", "ok"], ["Diff", "ok"]]);
    expect(input.phases[1].steps.map((s) => s.status)).toEqual(["ok", "skipped"]);
  });

  test("a phase with a failed step is fail; a phase whose steps all skipped is skipped", () => {
    const input = buildRunRecord(
      { name: "deploy" },
      [
        { phase: "Apply", fn: "kubectlApply", status: "fail", durationMs: 3, error: "boom" },
        { phase: "Verify", fn: "httpCheck", status: "skipped", durationMs: 0 },
      ],
      { started: "2026-01-01T00:00:00.000Z", ended: "2026-01-01T00:00:01.000Z", status: "fail" },
    );

    expect(input.status).toBe("fail");
    expect(input.env).toBe(DEFAULT_RUN_ENV);
    expect(input.phases.map((p) => [p.name, p.status])).toEqual([["Apply", "fail"], ["Verify", "skipped"]]);
    expect(input.phases[0].steps[0].error).toBe("boom");
  });
});

describe("appendRunRecord / readRunLedger", () => {
  test("round-trips a single record", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const { record } = await appendRunRecord(makeInput(), { cwd: dir });
      expect(record.version).toBe(1);
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/);

      const { records, malformed } = await readRunLedger("staging", "alb-deploy", { cwd: dir });
      expect(malformed).toBe(0);
      expect(records).toEqual([record]);
    });
  });

  test("appends without clobbering prior records", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendRunRecord(makeInput({ ended: "2026-01-01T00:00:12.000Z" }), { cwd: dir });
      await appendRunRecord(makeInput({ ended: "2026-01-01T00:10:12.000Z" }), { cwd: dir });
      await appendRunRecord(makeInput({ ended: "2026-01-01T00:20:12.000Z" }), { cwd: dir });

      const { records } = await readRunLedger("staging", "alb-deploy", { cwd: dir });
      expect(records.map((r) => r.ended)).toEqual([
        "2026-01-01T00:00:12.000Z",
        "2026-01-01T00:10:12.000Z",
        "2026-01-01T00:20:12.000Z",
      ]);
    });
  });

  test("one op's ledger is not another's, and neither disturbs the converge ledger in the same env", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendRunRecord(makeInput({ op: "alb-deploy" }), { cwd: dir });
      await appendRunRecord(makeInput({ op: "alb-teardown" }), { cwd: dir });
      await appendConvergeRecord(
        {
          op: "staging-converge",
          env: "staging",
          timestamp: "2026-01-01T00:00:00.000Z",
          firedRuleIds: [],
          outcomes: [],
          summary: { drifted: 0, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0 },
          log: "converge(staging): drifted=0",
        },
        { cwd: dir },
      );

      expect((await readRunLedger("staging", "alb-deploy", { cwd: dir })).records).toHaveLength(1);
      expect((await readRunLedger("staging", "alb-teardown", { cwd: dir })).records).toHaveLength(1);
      expect((await readConvergeLedger("staging", { cwd: dir })).records).toHaveLength(1);
    });
  });

  test("an unwritten ledger reads empty — never throws", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const { records, malformed } = await readRunLedger("nowhere", "nothing", { cwd: dir });
      expect(records).toEqual([]);
      expect(malformed).toBe(0);
    });
  });

  test("skips malformed lines but reports the count", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendRunRecord(makeInput(), { cwd: dir });

      const { readBlobFromPath, writeBlobToPath } = await import("./git");
      const existing = await readBlobFromPath("staging", "runs__alb-deploy.jsonl", { cwd: dir });
      const corrupted = `${existing}\n${JSON.stringify({ version: 1, op: "alb-deploy", env: "staging" })}`;
      await writeBlobToPath("staging", "runs__alb-deploy.jsonl", corrupted, "corrupt", { cwd: dir });

      const { records, malformed } = await readRunLedger("staging", "alb-deploy", { cwd: dir });
      expect(records).toHaveLength(1);
      expect(malformed).toBe(1);
    });
  });

  test("a gated record written by hand round-trips (#2119 produces these; the type carries the status now)", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendRunRecord(
        makeInput({
          status: "gated",
          phases: [
            { name: "Plan", status: "ok", steps: [{ fn: "terraformPlan", status: "ok", durationMs: 900 }] },
            { name: "Approve", status: "skipped", steps: [{ fn: "gate:approve-apply", status: "skipped", durationMs: 0 }] },
          ],
        }),
        { cwd: dir },
      );

      const { records } = await readRunLedger("staging", "alb-deploy", { cwd: dir });
      expect(records[0].status).toBe("gated");
      expect(records[0].phases[1]).toMatchObject({ name: "Approve", status: "skipped" });
    });
  });
});

describe("runOpLocally → the run ledger", () => {
  test("a successful run appends exactly one record, and the result carries the same document", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const activities = new Map<string, ActivityFn>([["ok", async () => ({ drifted: false })]]);
      const config = opConfig({
        phases: [
          {
            name: "Apply",
            steps: [{ kind: "activity", fn: "ok", args: {}, outcomeAttribute: { name: "Drift", from: "drifted" } }],
          },
        ],
      });

      const result = await runOpLocally(config, activities, NO_PROFILES, undefined, { ledger: { cwd: dir } });

      const { records } = await readRunLedger("staging", "alb-deploy", { cwd: dir });
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual(result.record);
      expect(records[0].status).toBe("ok");
      expect(records[0].outcomes).toEqual({ Drift: false });
      expect(records[0].labels).toEqual({ Env: "staging" });
    });
  });

  test("a failed run appends a fail record and still rejects with OpRunFailure", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const activities = new Map<string, ActivityFn>([
        ["ok", async () => { throw new Error("boom"); }],
      ]);

      const err = await runOpLocally(opConfig(), activities, NO_PROFILES, undefined, { ledger: { cwd: dir } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpRunFailure);

      const { records } = await readRunLedger("staging", "alb-deploy", { cwd: dir });
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("fail");
      expect(records[0].phases[0].steps[0].error).toContain("boom");
      expect((err as OpRunFailure).result.record).toEqual(records[0]);
    });
  });

  test("without the ledger option a run writes nothing, but still carries its record", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const activities = new Map<string, ActivityFn>([["ok", async () => ({})]]);

      const result = await runOpLocally(opConfig(), activities, NO_PROFILES);

      expect(result.record.op).toBe("alb-deploy");
      expect(result.record.status).toBe("ok");
      expect((await readRunLedger("staging", "alb-deploy", { cwd: dir })).records).toEqual([]);
    });
  });
});
