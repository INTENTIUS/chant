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
import { spritesUp, spritesDown } from "./sprites-emulator";

// The checkpoint-as-compensation loop against the REAL spritzer image
// (ghcr.io/intentius/spritzer), booted via `spritesUp` — the twin of fly's
// mudflaps integration test. Proves the image is wire-compatible with the
// in-process fake the CI test uses. Docker required; deterministically skipped
// in CI (GitHub runners have Docker, so relying on absence would pull the image
// on every run). Run locally, or opt in with SPRITES_DOCKER=1.

const CONTAINER = "chant-spritzer-it";
const PORT = 4292;
const PROFILES: Record<string, ActivityProfile> = {
  longInfra: { startToCloseTimeout: "5m", retry: { maximumAttempts: 3, initialInterval: "50ms", backoffCoefficient: 1 } },
  fastIdempotent: { startToCloseTimeout: "5m", retry: { maximumAttempts: 2, initialInterval: "50ms", backoffCoefficient: 1 } },
};

let available = false;
let endpoint = "";
let activities: Map<string, ActivityFn>;
let prevBaseUrl: string | undefined;

async function inspect(id: string): Promise<{ status: string; fs: Record<string, string>; checkpoints: string[] }> {
  const res = await fetch(`${endpoint}/v1/sprites/${id}`);
  return (await res.json()) as { status: string; fs: Record<string, string>; checkpoints: string[] };
}

beforeAll(async () => {
  if (process.env.CI && !process.env.SPRITES_DOCKER) {
    available = false;
    return;
  }
  try {
    const up = await spritesUp({ name: CONTAINER, port: PORT, timeoutMs: 30_000 });
    endpoint = up.endpoint;
    prevBaseUrl = process.env.SPRITES_BASE_URL;
    process.env.SPRITES_BASE_URL = endpoint;
    activities = await loadActivities(["temporal"]);
    available = true;
  } catch {
    available = false;
  }
}, 60_000);

afterAll(async () => {
  if (prevBaseUrl === undefined) delete process.env.SPRITES_BASE_URL;
  else process.env.SPRITES_BASE_URL = prevBaseUrl;
  if (available) await spritesDown({ name: CONTAINER });
});

describe("sprites against the live spritzer image (#786)", () => {
  test("guarded-task: Run fails, onFailure Restore rewinds the sprite to the checkpoint", async (ctx) => {
    if (!available) ctx.skip();
    const op: OpConfig = {
      name: "guarded-task",
      overview: "checkpoint, run a risky step, restore on failure",
      taskQueue: "sprites",
      phases: [
        phase("Create", [spriteCreate({ name: "guard-1" })]),
        phase("Seed", [spriteExec({ id: "guard-1", cmd: "echo good > /state" })]),
        phase("Checkpoint", [spriteCheckpoint({ id: "guard-1", comment: "pre-run" })]),
        phase("Run", [spriteExec({ id: "guard-1", cmd: "echo bad > /state; false" })]),
        phase("Destroy", [spriteDestroy({ id: "guard-1" })]),
      ],
      onFailure: [phase("Restore", [spriteRestore({ id: "guard-1", comment: "pre-run" })])],
    };

    let failure: OpRunFailure | undefined;
    try {
      await runOpLocally(op, activities, PROFILES);
    } catch (err) {
      failure = err as OpRunFailure;
    }
    expect(failure).toBeInstanceOf(OpRunFailure); // the risky Run failed
    const records = failure!.result.records;
    expect(records.find((r) => r.phase === "Run")?.status).toBe("fail");
    // Compensation ran against the live image.
    const restore = records.find((r) => r.phase === "Restore");
    expect(restore?.fn).toBe("spriteRestore");
    expect(restore?.status).toBe("ok");

    const state = await inspect("guard-1");
    expect(state.fs["/state"]).toBe("good"); // rewound past the "bad" write
  });
});
