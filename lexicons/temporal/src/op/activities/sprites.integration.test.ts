import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  loadActivities,
  runOpLocally,
  OpRunFailure,
  phase,
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteRestore,
  spriteDestroy,
  type ActivityFn,
  type ActivityProfile,
  type OpConfig,
} from "@intentius/chant/op";
import { createSpritesFake } from "./sprites-fake";

// End-to-end against the in-process fake (S7) — no Docker, runs in CI. The
// activities resolve by name through `loadActivities(["temporal"])` and reach
// the fake via `SPRITES_BASE_URL`. Fast profiles so retry loops run in ms.

const PROFILES: Record<string, ActivityProfile> = {
  longInfra: { startToCloseTimeout: "5m", retry: { maximumAttempts: 3, initialInterval: "1ms", backoffCoefficient: 1 } },
  fastIdempotent: { startToCloseTimeout: "5m", retry: { maximumAttempts: 2, initialInterval: "1ms", backoffCoefficient: 1 } },
};

let fake: { url: string; close(): Promise<void> };
let activities: Map<string, ActivityFn>;
let prevBaseUrl: string | undefined;

beforeAll(async () => {
  fake = await createSpritesFake();
  // Prove endpoint override via the env (S3): the same Op targets the fake with
  // no code change. Activities read SPRITES_BASE_URL when no `endpoint` arg is set.
  prevBaseUrl = process.env.SPRITES_BASE_URL;
  process.env.SPRITES_BASE_URL = fake.url;
  activities = await loadActivities(["temporal"]);
});

afterAll(async () => {
  if (prevBaseUrl === undefined) delete process.env.SPRITES_BASE_URL;
  else process.env.SPRITES_BASE_URL = prevBaseUrl;
  await fake?.close();
});

/** Read a sprite's live state (fs + checkpoints) from the fake. */
async function inspect(id: string): Promise<{ status: string; fs: Record<string, string>; checkpoints: string[] }> {
  const res = await fetch(`${fake.url}/v1/sprites/${id}`);
  return (await res.json()) as { status: string; fs: Record<string, string>; checkpoints: string[] };
}

describe("sprite activities resolve by name (S2)", () => {
  test("loadActivities([\"temporal\"]) exposes the five sprite activities", () => {
    for (const fn of ["spriteCreate", "spriteExec", "spriteCheckpoint", "spriteRestore", "spriteDestroy"]) {
      expect(typeof activities.get(fn)).toBe("function");
    }
  });
});

describe("agent-task happy path", () => {
  test("Create → Checkpoint → Run → Verify → Destroy runs green end to end", async () => {
    const op: OpConfig = {
      name: "agent-task",
      overview: "happy path",
      taskQueue: "sprites",
      phases: [
        phase("Create", [spriteCreate({ name: "task-1" })]),
        phase("Checkpoint", [spriteCheckpoint({ id: "task-1", label: "pre-run" })]),
        phase("Run", [spriteExec({ id: "task-1", cmd: "echo hello > /work/output" })]),
        phase("Verify", [spriteExec({ id: "task-1", cmd: "cat /work/output" })]),
        phase("Destroy", [spriteDestroy({ id: "task-1" })]),
      ],
    };
    const result = await runOpLocally(op, activities, PROFILES);
    expect(result.ok).toBe(true);
    expect(result.records.map((r) => r.fn)).toEqual([
      "spriteCreate",
      "spriteCheckpoint",
      "spriteExec",
      "spriteExec",
      "spriteDestroy",
    ]);
    expect(result.records.every((r) => r.status === "ok")).toBe(true);
  });

  test("exec mutates the sprite fs (checkpoint/restore observability)", async () => {
    const op: OpConfig = {
      name: "agent-write",
      overview: "state observability",
      phases: [
        phase("Create", [spriteCreate({ name: "obs-1" })]),
        phase("Run", [spriteExec({ id: "obs-1", cmd: "echo hello > /work/output" })]),
      ],
    };
    await runOpLocally(op, activities, PROFILES);
    const state = await inspect("obs-1");
    expect(state.fs).toEqual({ "/work/output": "hello" });
  });
});

describe("guarded-task — checkpoint-as-compensation (S5)", () => {
  test("Run fails → onFailure Restore runs → fs is rewound to the pre-run checkpoint", async () => {
    const op: OpConfig = {
      name: "guarded-task",
      overview: "checkpoint, run a risky step, restore on failure",
      taskQueue: "sprites",
      phases: [
        phase("Create", [spriteCreate({ name: "guard-1" })]),
        phase("Seed", [spriteExec({ id: "guard-1", cmd: "echo good > /state" })]),
        phase("Checkpoint", [spriteCheckpoint({ id: "guard-1", label: "pre-run" })]),
        // Overwrites the good state, then fails — the risky phase.
        phase("Run", [spriteExec({ id: "guard-1", cmd: "echo bad > /state; false" })]),
        phase("Destroy", [spriteDestroy({ id: "guard-1" })]),
      ],
      onFailure: [phase("Restore", [spriteRestore({ id: "guard-1", checkpoint: "pre-run" })])],
    };

    let failure: OpRunFailure | undefined;
    try {
      await runOpLocally(op, activities, PROFILES);
    } catch (err) {
      failure = err as OpRunFailure;
    }

    // The Op failed at the risky Run and never reached Destroy.
    expect(failure).toBeInstanceOf(OpRunFailure);
    const records = failure!.result.records;
    const run = records.find((r) => r.phase === "Run");
    expect(run?.status).toBe("fail");
    expect(records.some((r) => r.phase === "Destroy")).toBe(false);

    // Compensation ran: onFailure Restore executed and succeeded.
    const restore = records.find((r) => r.phase === "Restore");
    expect(restore?.fn).toBe("spriteRestore");
    expect(restore?.status).toBe("ok");

    // The environment is the transaction: fs is back to the checkpoint state.
    const state = await inspect("guard-1");
    expect(state.fs).toEqual({ "/state": "good" });
    expect(state.status).toBe("running");
  });

  test("control: without onFailure the risky write is NOT rewound (fs stays corrupt)", async () => {
    const op: OpConfig = {
      name: "unguarded-task",
      overview: "no compensation",
      phases: [
        phase("Create", [spriteCreate({ name: "unguard-1" })]),
        phase("Seed", [spriteExec({ id: "unguard-1", cmd: "echo good > /state" })]),
        phase("Checkpoint", [spriteCheckpoint({ id: "unguard-1", label: "pre-run" })]),
        phase("Run", [spriteExec({ id: "unguard-1", cmd: "echo bad > /state; false" })]),
      ],
    };
    await expect(runOpLocally(op, activities, PROFILES)).rejects.toBeInstanceOf(OpRunFailure);
    const state = await inspect("unguard-1");
    expect(state.fs).toEqual({ "/state": "bad" });
  });
});
