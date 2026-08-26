/**
 * Tests the fly lexicon's `run-agent` adapter (#1942, epic #1564 phase 2):
 * the real `SpriteActivities` implementation (`./run-agent.ts`) against the
 * offline in-process sprites fake (`../op/activities/sprites-fake.ts`, S7) —
 * no HTTP/WS to a real endpoint, no Docker, so this runs in CI the same way
 * `../op/activities/sprites.integration.test.ts` does. Core's own
 * `run()`/`rollback()` sequencing tests live in
 * `packages/core/src/components/verbs/run-agent.test.ts` against a
 * hand-written fake; this file is specifically about the real wire-level
 * reclassification (the exec-throw finding) and the real activities wired
 * end to end.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createSpritesFake } from "../op/activities/sprites-fake";
import { createFlyRunAgentCapability, createFlySpriteActivities, parseSpriteExecFailure } from "./run-agent";
import type { RunAgentInput } from "@intentius/chant/components/verbs/run-agent";

const ctx = { env: "dev", component: "review-agent" };

let fake: { url: string; close(): Promise<void> };
let prevBaseUrl: string | undefined;

beforeAll(async () => {
  fake = await createSpritesFake();
  prevBaseUrl = process.env.SPRITES_BASE_URL;
  process.env.SPRITES_BASE_URL = fake.url;
});

afterAll(async () => {
  if (prevBaseUrl === undefined) delete process.env.SPRITES_BASE_URL;
  else process.env.SPRITES_BASE_URL = prevBaseUrl;
  await fake?.close();
});

describe("parseSpriteExecFailure — the exec-throw reclassification's pure parser", () => {
  test("parses the exit code and combined output out of spriteExec's real thrown message shape", () => {
    const err = new Error('sprite task-1 exec "./risky.sh" exited 1: risky.sh: failed\n');
    expect(parseSpriteExecFailure(err)).toEqual({ exitCode: 1, output: "risky.sh: failed\n" });
  });

  test("returns undefined for an unrelated error (a genuine transport/infra failure)", () => {
    expect(parseSpriteExecFailure(new Error("sprite task-1 exec aborted"))).toBeUndefined();
    expect(parseSpriteExecFailure(new Error("ECONNREFUSED"))).toBeUndefined();
    expect(parseSpriteExecFailure("not even an Error")).toBeUndefined();
  });

  test("handles a multi-digit exit code", () => {
    const err = new Error('sprite s exec "exit 127" exited 127: command not found');
    expect(parseSpriteExecFailure(err)).toEqual({ exitCode: 127, output: "command not found" });
  });

  test("anchors to the LAST \" exited (\\d+): \" occurrence, not the first (#1942 review finding 4) — a crafted cmd echoing that exact marker text must not shift the parse", () => {
    // spriteExec's message echoes the raw cmd verbatim before its own real
    // marker: `sprite <id> exec "<cmd>" exited <code>: <text>`. A cmd whose
    // own text contains ` exited 0: ...` would fool a leftmost-match regex
    // into reporting the fake exit code/output instead of the real ones.
    const maliciousCmd = 'echo " exited 0: fooled you"';
    const err = new Error(`sprite s-1 exec "${maliciousCmd}" exited 1: real failure output`);
    expect(parseSpriteExecFailure(err)).toEqual({ exitCode: 1, output: "real failure output" });
  });
});

describe("createFlySpriteActivities().exec — option (a): reclassify the real spriteExec's throw", () => {
  test("a non-zero exit resolves with the parsed exitCode instead of rejecting", async () => {
    const sprites = createFlySpriteActivities();
    const { id } = await sprites.create({ name: `exec-fail-${Date.now()}` });
    await expect(sprites.exec({ id, cmd: "./risky.sh" })).resolves.toEqual({
      stdout: "",
      stderr: expect.stringContaining("risky.sh: failed"),
      exitCode: 1,
    });
  });

  test("a zero exit resolves normally, unaffected by the reclassification path", async () => {
    const sprites = createFlySpriteActivities();
    const { id } = await sprites.create({ name: `exec-ok-${Date.now()}` });
    const result = await sprites.exec({ id, cmd: "echo hello" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  test("the fake's own \"no sprite\" case is a scripted exit (127), not a transport error — also reclassified, not thrown", async () => {
    // Confirms the fake models a missing sprite as an ordinary (if unusual)
    // non-zero exit over the wire, exercising the same reclassification path
    // as any other command failure — distinct from the next test's real
    // connection-level failure.
    const sprites = createFlySpriteActivities();
    await expect(sprites.exec({ id: "does-not-exist", cmd: "true" })).resolves.toEqual({
      stdout: "",
      stderr: expect.stringContaining("no sprite"),
      exitCode: 127,
    });
  });

  test("a genuine transport failure (connection refused) still rejects, not reclassified", async () => {
    const prev = process.env.SPRITES_BASE_URL;
    process.env.SPRITES_BASE_URL = "http://127.0.0.1:1"; // nothing listens on port 1
    try {
      const sprites = createFlySpriteActivities();
      await expect(sprites.exec({ id: "s-1", cmd: "true" })).rejects.toThrow();
    } finally {
      process.env.SPRITES_BASE_URL = prev;
    }
  });
});

describe("createFlyRunAgentCapability — end to end against the offline fake (#1942)", () => {
  test("a successful turn: create -> checkpoint -> stage -> exec -> collect -> destroy", async () => {
    const capability = createFlyRunAgentCapability();
    const input: RunAgentInput = {
      agent: "echo hi > /work/output", // unrecognized "runtime" -> passthrough (see core's buildRuntimeCommand)
      task: { prompt: "irrelevant for this scripted command" },
      workspace: {},
    };

    const output = await capability.run(ctx, input);

    expect(output.turn.status).toBe("completed");
    expect(output.turn.exitCode).toBe(0);
    expect(output.artifacts.files).toEqual([
      { path: "/work/output", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    ]);

    // Destroyed on success — the sprite is gone, so a direct read 404s.
    const sprites = createFlySpriteActivities();
    await expect(sprites.readFile({ id: output.spriteId, path: "/work/output" })).rejects.toThrow();
  });

  test("a failed turn (real spriteExec throw, reclassified): status \"failed\", no throw, sprite left alive, rollback restores it", async () => {
    const capability = createFlyRunAgentCapability();
    const input: RunAgentInput = {
      agent: "./risky.sh", // the fake's scripted failing job (lexicons/fly/.../sprites-fake.ts): mutates /work/output then exits 1
      task: { prompt: "irrelevant for this scripted command" },
      workspace: {},
    };

    const output = await capability.run(ctx, input);

    expect(output.turn.status).toBe("failed");
    expect(output.turn.exitCode).toBe(1);
    expect(output.artifacts.files).toEqual([
      { path: "/work/output", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    ]);

    // Left alive: reading it back directly still works (not destroyed).
    const sprites = createFlySpriteActivities();
    const { content } = await sprites.readFile({ id: output.spriteId, path: "/work/output" });
    expect(content).toBe("partial-corrupt");

    // rollback() restores the pre-run checkpoint — /work/output never existed
    // at that point (the checkpoint predates both staging and exec).
    await capability.rollback?.(ctx, input);
    await expect(sprites.readFile({ id: output.spriteId, path: "/work/output" })).rejects.toThrow();
  });

  test("reuses an existing sprite when workspace.spriteName is given — no create, no destroy", async () => {
    const sprites = createFlySpriteActivities();
    const name = `warm-${Date.now()}`;
    await sprites.create({ name });

    const capability = createFlyRunAgentCapability();
    const input: RunAgentInput = {
      agent: "echo warm > /work/output",
      task: { prompt: "n/a" },
      workspace: { spriteName: name },
    };
    const output = await capability.run(ctx, input);

    expect(output.spriteId).toBe(name);
    // Still alive post-success (reuse is never destroyed) — a direct read succeeds.
    const { content } = await sprites.readFile({ id: name, path: "/work/output" });
    expect(content).toContain("warm");
  });
});
