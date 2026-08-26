/**
 * Tests `run-agent` (#1941 phase 1 — capability schema + registry entry;
 * #1942 phase 2 — sprite lifecycle wiring, ./run-agent.ts). The schema/
 * registration tests (kind, `rollbackPolicy`, COMP003-relevant registry
 * behavior) are unchanged from phase 1; the sequencing tests below
 * (successful turn, failed turn, rollback, unwind-on-throw, runtime command
 * parameterization) exercise `run()`/`rollback()`'s real logic against a
 * hand-written `SpriteActivities` fake — no HTTP/WS, no real or emulated
 * sprite. The fly lexicon's own tests (`lexicons/fly/src/components/
 * run-agent.test.ts`) cover the real adapter (the exec-throw reclassification
 * in particular) against the offline `sprites-fake`; #1944 owns the full
 * contract/conformance suite (saga-unwind restore, COMP003 refusal) beyond
 * both.
 */

import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../capability";
import {
  buildRuntimeCommand,
  createRunAgentCapability,
  defaultSpriteActivities,
  runAgentCapability,
  SpriteActivitiesNotWiredError,
  type RunAgentInput,
  type RunAgentOutput,
  type SpriteActivities,
} from "./run-agent";

const ctx = { env: "dev", component: "review-agent" };

const MINIMAL_INPUT: RunAgentInput = {
  agent: "code-reviewer",
  task: { prompt: "Review the open PR for regressions." },
  workspace: {},
};

describe("run-agent — capability schema + registry entry (#1941)", () => {
  it("declares kind \"run-agent\"", () => {
    const capability = createRunAgentCapability();
    expect(capability.kind).toBe("run-agent");
  });

  it("declares rollbackPolicy: \"native\" — COMP003 never requires a noRollback opt-out for this verb", () => {
    const capability = createRunAgentCapability();
    expect(capability.rollbackPolicy).toBe("native");
    // The same read `chant lint` performs when building `ctx.rollbackPolicies`
    // (packages/core/src/cli/commands/lint.ts): `rollbackPolicy ?? (rollback ? "native" : "none-by-design")`.
    const derived = capability.rollbackPolicy ?? (capability.rollback ? "native" : "none-by-design");
    expect(derived).toBe("native");
  });

  it("registers into a fresh CapabilityRegistry and resolves by kind", () => {
    const registry = new CapabilityRegistry();
    registry.register(createRunAgentCapability());
    expect(registry.has("run-agent")).toBe(true);
    const resolved = registry.resolve("run-agent");
    expect(resolved.kind).toBe("run-agent");
    expect(resolved.rollbackPolicy).toBe("native");
  });

  it("exports a default instance (runAgentCapability), backed by the not-wired-yet SpriteActivities", () => {
    expect(runAgentCapability.kind).toBe("run-agent");
    expect(runAgentCapability.rollbackPolicy).toBe("native");
  });

  it("RunAgentInput/RunAgentOutput compile against the schema described in the issue (#1941)", () => {
    const input: RunAgentInput = {
      agent: "code-reviewer",
      task: {
        prompt: "Summarize the diff.",
        images: [{ data: "base64==", media_type: "image/png" }],
      },
      workspace: {
        spriteName: "warm-review-sprite",
        image: "sprites/base:latest",
        checkpointComment: "pre-run",
      },
      sourceRef: "abc1234:packages/core",
    };
    const output: RunAgentOutput = {
      spriteId: "s-1",
      checkpointId: "v3",
      turn: { status: "completed", exitCode: 0, startedAt: "2026-08-25T00:00:00Z", endedAt: "2026-08-25T00:01:00Z" },
      artifacts: { files: [{ path: "report.md", digest: "sha256:" + "a".repeat(64) }], diff: "--- a\n+++ b\n" },
      provenance: { sourceRef: "abc1234:packages/core", artifactDigest: "sha256:" + "a".repeat(64) },
    };

    expect(input.agent).toBe("code-reviewer");
    expect(output.turn.status).toBe("completed");
  });
});

describe("defaultSpriteActivities — phase 1's not-wired-yet placeholder", () => {
  it("every method rejects with SpriteActivitiesNotWiredError, naming itself", async () => {
    const sprites = defaultSpriteActivities();
    await expect(sprites.create({ name: "s-1" })).rejects.toBeInstanceOf(SpriteActivitiesNotWiredError);
    await expect(sprites.create({ name: "s-1" })).rejects.toThrow(/SpriteActivities\.create: not wired/);
    await expect(sprites.checkpoint({ id: "s-1" })).rejects.toThrow(/SpriteActivities\.checkpoint: not wired/);
    await expect(sprites.exec({ id: "s-1", cmd: "true" })).rejects.toThrow(/SpriteActivities\.exec: not wired/);
    await expect(sprites.restore({ id: "s-1" })).rejects.toThrow(/SpriteActivities\.restore: not wired/);
    await expect(sprites.destroy({ id: "s-1" })).rejects.toThrow(/SpriteActivities\.destroy: not wired/);
    await expect(sprites.writeFile({ id: "s-1", path: "/x", content: "y" })).rejects.toThrow(
      /SpriteActivities\.writeFile: not wired/,
    );
    await expect(sprites.readFile({ id: "s-1", path: "/x" })).rejects.toThrow(
      /SpriteActivities\.readFile: not wired/,
    );
  });

  it("the error message points at #1942", async () => {
    const sprites = defaultSpriteActivities();
    await expect(sprites.create({ name: "s-1" })).rejects.toThrow(/#1942/);
  });

  it("the default runAgentCapability still throws (now on the first real activity call, not CapabilityNotImplementedError) when nothing is injected", async () => {
    await expect(runAgentCapability.run(ctx, MINIMAL_INPUT)).rejects.toBeInstanceOf(SpriteActivitiesNotWiredError);
  });
});

// ── run()/rollback() sequencing (#1942) ─────────────────────────────────────

/** A tiny in-memory `SpriteActivities` fake: one sprite's filesystem plus comment-keyed checkpoint snapshots — enough to prove checkpoint/restore is observable without any HTTP/WS (mirrors, at a smaller scale, `lexicons/fly/src/op/activities/sprites-fake.ts`'s in-process model). `execImpl` is the one piece a test overrides per scenario. */
function makeFakeSprites(
  execImpl: (args: { id: string; cmd: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): { sprites: SpriteActivities; calls: string[]; fs: Record<string, string> } {
  const calls: string[] = [];
  const fs: Record<string, string> = {};
  const checkpoints = new Map<string, Record<string, string>>();

  const sprites: SpriteActivities = {
    async create(args) {
      calls.push(`create:${args.name}`);
      return { id: args.name, url: `fake://${args.name}` };
    },
    async checkpoint(args) {
      const comment = args.comment ?? "";
      calls.push(`checkpoint:${comment}`);
      checkpoints.set(comment, { ...fs });
      return { checkpointId: `v${checkpoints.size}` };
    },
    async exec(args) {
      calls.push(`exec:${args.cmd}`);
      return execImpl(args);
    },
    async restore(args) {
      const comment = args.comment ?? "";
      calls.push(`restore:${args.id}:${comment}`);
      const snapshot = checkpoints.get(comment);
      if (!snapshot) throw new Error(`no checkpoint for comment "${comment}"`);
      for (const key of Object.keys(fs)) delete fs[key];
      Object.assign(fs, snapshot);
    },
    async destroy(args) {
      calls.push(`destroy:${args.id}`);
    },
    async writeFile(args) {
      calls.push(`writeFile:${args.path}`);
      fs[args.path] = args.content;
    },
    async readFile(args) {
      calls.push(`readFile:${args.path}`);
      if (!(args.path in fs)) throw new Error(`sprite ${args.id} read ${args.path}: not found`);
      return { content: fs[args.path] };
    },
  };
  return { sprites, calls, fs };
}

const succeed = async (): Promise<{ stdout: string; stderr: string; exitCode: number }> => ({
  stdout: "ok\n",
  stderr: "",
  exitCode: 0,
});

describe("run() — successful turn (#1942)", () => {
  it("sequences create -> checkpoint -> writeFile -> exec -> readFile -> destroy, and reports status \"completed\"", async () => {
    const { sprites, calls, fs } = makeFakeSprites(async () => {
      fs["/work/output"] = "ok\n";
      return succeed();
    });
    const capability = createRunAgentCapability(sprites);

    const output = await capability.run(ctx, MINIMAL_INPUT);

    expect(output.turn.status).toBe("completed");
    expect(output.turn.exitCode).toBe(0);
    expect(output.spriteId).toBeTruthy();
    expect(output.checkpointId).toBe("v1");
    expect(output.artifacts.files).toEqual([
      { path: "/work/output", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    ]);
    expect(output.provenance).toEqual({ sourceRef: "", artifactDigest: output.artifacts.files[0]?.digest });

    // Order matters: writeFile stages the prompt before exec runs, destroy is last.
    expect(calls[0]).toMatch(/^create:/);
    expect(calls[1]).toMatch(/^checkpoint:pre-run$/);
    expect(calls[2]).toBe("writeFile:/work/prompt");
    expect(calls[3]).toMatch(/^exec:/);
    expect(calls[4]).toBe("readFile:/work/output");
    expect(calls[5]).toMatch(/^destroy:/);
  });

  it("threads sourceRef into provenance when supplied", async () => {
    const { sprites } = makeFakeSprites(succeed);
    const capability = createRunAgentCapability(sprites);
    const output = await capability.run(ctx, { ...MINIMAL_INPUT, sourceRef: "abc123:packages/core" });
    expect(output.provenance.sourceRef).toBe("abc123:packages/core");
  });

  it("skips create() and destroy() when reusing an existing sprite (workspace.spriteName)", async () => {
    const { sprites, calls } = makeFakeSprites(succeed);
    const capability = createRunAgentCapability(sprites);
    const input: RunAgentInput = { ...MINIMAL_INPUT, workspace: { spriteName: "warm-sprite" } };

    const output = await capability.run(ctx, input);

    expect(output.spriteId).toBe("warm-sprite");
    expect(calls.some((c) => c.startsWith("create:"))).toBe(false);
    expect(calls.some((c) => c.startsWith("destroy:"))).toBe(false);
  });
});

describe("run() — failed turn: non-zero exit surfaces as status \"failed\", never a throw (#1942, the exec-throw finding)", () => {
  it("resolves (does not reject) with turn.status \"failed\" and the parsed exit code", async () => {
    const { sprites, calls } = makeFakeSprites(async () => ({ stdout: "", stderr: "boom\n", exitCode: 3 }));
    const capability = createRunAgentCapability(sprites);

    const output = await capability.run(ctx, MINIMAL_INPUT);

    expect(output.turn.status).toBe("failed");
    expect(output.turn.exitCode).toBe(3);
    // Left alive — no destroy on a failed turn, so a caller can inspect/rollback it.
    expect(calls.some((c) => c.startsWith("destroy:"))).toBe(false);
  });

  it("still collects artifacts.files when the failing turn wrote output before exiting non-zero", async () => {
    const { sprites, fs } = makeFakeSprites(async () => {
      fs["/work/output"] = "partial-corrupt";
      return { stdout: "", stderr: "", exitCode: 1 };
    });
    const capability = createRunAgentCapability(sprites);
    const output = await capability.run(ctx, MINIMAL_INPUT);
    expect(output.artifacts.files).toEqual([
      { path: "/work/output", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    ]);
  });

  it("leaves artifacts.files empty when the failing turn never wrote output at all", async () => {
    const { sprites } = makeFakeSprites(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
    const capability = createRunAgentCapability(sprites);
    const output = await capability.run(ctx, MINIMAL_INPUT);
    expect(output.artifacts.files).toEqual([]);
  });
});

describe("rollback() restores the pre-run checkpoint (#1942)", () => {
  it("restores the sprite's filesystem to its pre-run state after a failed turn", async () => {
    const { sprites, fs } = makeFakeSprites(async () => {
      fs["/work/output"] = "corrupted";
      return { stdout: "", stderr: "it broke", exitCode: 1 };
    });
    const capability = createRunAgentCapability(sprites);

    const output = await capability.run(ctx, MINIMAL_INPUT);
    expect(output.turn.status).toBe("failed");
    expect(fs["/work/output"]).toBe("corrupted");
    expect(fs["/work/prompt"]).toBe(MINIMAL_INPUT.task.prompt); // staged after the checkpoint

    await capability.rollback?.(ctx, MINIMAL_INPUT);

    // The pre-run checkpoint predates both the staged prompt and the exec's
    // output — restore rewinds the sprite to before either existed.
    expect(fs["/work/output"]).toBeUndefined();
    expect(fs["/work/prompt"]).toBeUndefined();
  });

  it("resolves the sprite id from the WeakMap keyed by the exact input object run() was called with", async () => {
    const { sprites, calls } = makeFakeSprites(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
    const capability = createRunAgentCapability(sprites);
    const output = await capability.run(ctx, MINIMAL_INPUT);

    await capability.rollback?.(ctx, MINIMAL_INPUT);

    expect(calls.at(-1)).toBe(`restore:${output.spriteId}:pre-run`);
  });

  it("falls back to workspace.spriteName when there is no in-process run() record for this input", async () => {
    const { sprites, calls } = makeFakeSprites(succeed);
    // Simulate an earlier process/instance having already checkpointed this
    // warm sprite — otherwise there is nothing for a bare restore to find,
    // regardless of which sprite id it resolves.
    await sprites.checkpoint({ id: "warm-sprite", comment: "pre-run" });
    calls.length = 0;
    const capability = createRunAgentCapability(sprites);
    const input: RunAgentInput = { ...MINIMAL_INPUT, workspace: { spriteName: "warm-sprite" } };

    // No run() call at all — a fresh capability instance calling rollback()
    // directly, the same as a caller resuming against an already-created sprite.
    await capability.rollback?.(ctx, input);

    expect(calls).toEqual([`restore:warm-sprite:pre-run`]);
  });

  it("throws a descriptive error when neither an in-process record nor workspace.spriteName is available", async () => {
    const { sprites } = makeFakeSprites(succeed);
    const capability = createRunAgentCapability(sprites);
    await expect(capability.rollback?.(ctx, MINIMAL_INPUT)).rejects.toThrow(/no sprite id to restore/);
  });

  it("honors a custom workspace.checkpointComment for both checkpoint and restore", async () => {
    const { sprites, calls } = makeFakeSprites(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
    const capability = createRunAgentCapability(sprites);
    const input: RunAgentInput = { ...MINIMAL_INPUT, workspace: { checkpointComment: "before-turn" } };

    await capability.run(ctx, input);
    await capability.rollback?.(ctx, input);

    expect(calls).toContain("checkpoint:before-turn");
    expect(calls.some((c) => c.startsWith("restore:") && c.endsWith(":before-turn"))).toBe(true);
  });
});

describe("unwind-on-throw: a genuine infra failure propagates as a run() rejection (#1942)", () => {
  it("a rejecting checkpoint() call fails run() outright — no synthesized turn.status", async () => {
    const { sprites, calls } = makeFakeSprites(succeed);
    sprites.checkpoint = async () => {
      throw new Error("sprite backend unreachable");
    };
    const capability = createRunAgentCapability(sprites);

    await expect(capability.run(ctx, MINIMAL_INPUT)).rejects.toThrow(/sprite backend unreachable/);
    // exec/writeFile never ran — the failure happened before them.
    expect(calls.some((c) => c.startsWith("exec:"))).toBe(false);
    expect(calls.some((c) => c.startsWith("writeFile:"))).toBe(false);
  });

  it("a rejecting exec() call (a real transport failure, not an ordinary non-zero exit) fails run() outright", async () => {
    const { sprites } = makeFakeSprites(async () => {
      throw new Error("sprite exec aborted");
    });
    const capability = createRunAgentCapability(sprites);
    await expect(capability.run(ctx, MINIMAL_INPUT)).rejects.toThrow(/sprite exec aborted/);
  });

  it("rollback() still restores after a post-checkpoint throw, mirroring driver.ts's in-process saga unwind", async () => {
    const { sprites, fs } = makeFakeSprites(succeed);
    const realWriteFile = sprites.writeFile.bind(sprites);
    let failNext = true;
    sprites.writeFile = async (args, signal) => {
      if (failNext) {
        failNext = false;
        throw new Error("sprite fs unreachable");
      }
      return realWriteFile(args, signal);
    };
    const capability = createRunAgentCapability(sprites);

    await expect(capability.run(ctx, MINIMAL_INPUT)).rejects.toThrow(/sprite fs unreachable/);
    // driver.ts's saga unwind would call rollback() with this exact input next.
    await capability.rollback?.(ctx, MINIMAL_INPUT);
    expect(fs["/work/prompt"]).toBeUndefined(); // checkpoint predates the write that never landed
  });
});

describe("buildRuntimeCommand — runtime parameterization (#1942 acceptance: not hard-coded to one runtime)", () => {
  it("dispatches a distinct, real invocation per known Agent.runtime value", () => {
    const claude = buildRuntimeCommand("claude");
    const codex = buildRuntimeCommand("codex");
    const gemini = buildRuntimeCommand("gemini");
    const opencode = buildRuntimeCommand("opencode");

    expect(claude).toContain("claude");
    expect(codex).toContain("codex");
    expect(gemini).toContain("gemini");
    expect(opencode).toContain("opencode");

    const commands = [claude, codex, gemini, opencode];
    expect(new Set(commands).size).toBe(commands.length); // all four differ
  });

  it("reads the staged prompt file rather than embedding the prompt text literally", () => {
    expect(buildRuntimeCommand("claude")).toContain("/work/prompt");
  });

  it("passes an unrecognized agent value through verbatim (the offline-fake escape hatch)", () => {
    expect(buildRuntimeCommand("./risky.sh")).toBe("./risky.sh");
    expect(buildRuntimeCommand("true")).toBe("true");
  });

  it("run() builds the exec command from input.agent, proving the runtime is not hard-coded", async () => {
    const { sprites, calls } = makeFakeSprites(succeed);
    const capability = createRunAgentCapability(sprites);
    await capability.run(ctx, { ...MINIMAL_INPUT, agent: "codex" });
    expect(calls.find((c) => c.startsWith("exec:"))).toBe(`exec:${buildRuntimeCommand("codex")}`);
  });
});
