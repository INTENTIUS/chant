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
  buildRunAgentProvenanceStatement,
  buildRuntimeCommand,
  computeTranscriptDigest,
  createRunAgentCapability,
  defaultSpriteActivities,
  extractTranscriptDigest,
  RUN_AGENT_BUILD_TYPE,
  runAgentCapability,
  SpriteActivitiesNotWiredError,
  toRunAgentArchiveEntry,
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
      provenance: { sourceRef: "abc1234:packages/core@sha256:" + "b".repeat(64), artifactDigest: "sha256:" + "a".repeat(64) },
      attestationRef: "review-agent/run-agent@sha256:" + "b".repeat(64),
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

/**
 * A tiny in-memory `SpriteActivities` fake: one sprite's filesystem plus a
 * checkpoint list (id + comment + snapshot) — enough to prove checkpoint/
 * restore is observable without any HTTP/WS (mirrors, at a smaller scale,
 * `lexicons/fly/src/op/activities/sprites-fake.ts`'s in-process model).
 * `execImpl` is the one piece a test overrides per scenario.
 *
 * `restore` mirrors the real `spriteRestore`'s resolution order
 * (`lexicons/fly/src/op/activities/sprites.ts`): an explicit `checkpoint` id
 * wins outright; otherwise the *newest* checkpoint carrying `comment` — so a
 * reused sprite with two "pre-run"-commented checkpoints exercises the exact
 * ambiguity the real backend has (regression coverage for #1942 review
 * finding 1).
 */
function makeFakeSprites(
  execImpl: (args: { id: string; cmd: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): { sprites: SpriteActivities; calls: string[]; fs: Record<string, string> } {
  const calls: string[] = [];
  const fs: Record<string, string> = {};
  const checkpoints: Array<{ id: string; comment: string; snapshot: Record<string, string> }> = [];

  const sprites: SpriteActivities = {
    async create(args) {
      calls.push(`create:${args.name}`);
      return { id: args.name, url: `fake://${args.name}` };
    },
    async checkpoint(args) {
      const comment = args.comment ?? "";
      const id = `v${checkpoints.length + 1}`;
      calls.push(`checkpoint:${comment}`);
      checkpoints.push({ id, comment, snapshot: { ...fs } });
      return { checkpointId: id };
    },
    async exec(args) {
      calls.push(`exec:${args.cmd}`);
      return execImpl(args);
    },
    async restore(args) {
      let entry: { id: string; comment: string; snapshot: Record<string, string> } | undefined;
      if (args.checkpoint !== undefined) {
        calls.push(`restore:${args.id}:checkpoint=${args.checkpoint}`);
        entry = checkpoints.find((c) => c.id === args.checkpoint);
        if (!entry) throw new Error(`no checkpoint "${args.checkpoint}" for sprite ${args.id}`);
      } else {
        const comment = args.comment ?? "";
        calls.push(`restore:${args.id}:comment=${comment}`);
        // Newest matching comment — mirrors `pickCheckpointByComment`.
        entry = [...checkpoints].reverse().find((c) => c.comment === comment);
        if (!entry) throw new Error(`no checkpoint for comment "${comment}"`);
      }
      for (const key of Object.keys(fs)) delete fs[key];
      Object.assign(fs, entry.snapshot);
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
    // #1943: no input.sourceRef supplied -> provenance.sourceRef is the bare
    // transcript digest, no folding.
    expect(output.provenance.sourceRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(output.provenance).toEqual({ sourceRef: output.provenance.sourceRef, artifactDigest: output.artifacts.files[0]?.digest });
    expect(output.attestationRef).toBe(`${ctx.component}/run-agent@${output.provenance.sourceRef}`);

    // Order matters: writeFile stages the prompt before exec runs, destroy is last.
    expect(calls[0]).toMatch(/^create:/);
    expect(calls[1]).toMatch(/^checkpoint:pre-run$/);
    expect(calls[2]).toBe("writeFile:/work/prompt");
    expect(calls[3]).toMatch(/^exec:/);
    expect(calls[4]).toBe("readFile:/work/output");
    expect(calls[5]).toMatch(/^destroy:/);
  });

  it("folds input.sourceRef with the transcript digest via '@' (#1943)", async () => {
    const { sprites } = makeFakeSprites(succeed);
    const capability = createRunAgentCapability(sprites);
    const output = await capability.run(ctx, { ...MINIMAL_INPUT, sourceRef: "abc123:packages/core" });
    expect(output.provenance.sourceRef).toMatch(/^abc123:packages\/core@sha256:[0-9a-f]{64}$/);
    expect(extractTranscriptDigest(output.provenance.sourceRef)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(output.attestationRef).toBe(`${ctx.component}/run-agent@${extractTranscriptDigest(output.provenance.sourceRef)}`);
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

describe("collectArtifacts — only a \"not found\" read means \"no artifact\"; a genuine infra failure propagates (#1942 review finding 2)", () => {
  it("branch A: readFile rejecting with the sprite-fs \"not found\" shape resolves to empty artifacts.files, not a run() rejection", async () => {
    const { sprites } = makeFakeSprites(succeed); // never writes /work/output — readFile hits the fake's "not found" branch
    const capability = createRunAgentCapability(sprites);
    await expect(capability.run(ctx, MINIMAL_INPUT)).resolves.toMatchObject({ artifacts: { files: [] } });
  });

  it("branch B: readFile rejecting with a genuine infra-failure shape propagates as a run() rejection, not swallowed into empty artifacts.files", async () => {
    const { sprites } = makeFakeSprites(succeed);
    sprites.readFile = async () => {
      throw new Error("sprite s-1 read /work/output failed (500): backend unavailable");
    };
    const capability = createRunAgentCapability(sprites);
    await expect(capability.run(ctx, MINIMAL_INPUT)).rejects.toThrow(/failed \(500\): backend unavailable/);
  });

  it("branch B (variant): a non-Error/non-string rejection from readFile still propagates rather than being treated as \"not found\"", async () => {
    const { sprites } = makeFakeSprites(succeed);
    sprites.readFile = async () => {
      throw new Error("ECONNRESET");
    };
    const capability = createRunAgentCapability(sprites);
    await expect(capability.run(ctx, MINIMAL_INPUT)).rejects.toThrow(/ECONNRESET/);
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

  it("resolves the sprite id AND restores by the exact recorded checkpoint id (not comment) from the WeakMap keyed by the exact input object run() was called with", async () => {
    const { sprites, calls } = makeFakeSprites(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
    const capability = createRunAgentCapability(sprites);
    const output = await capability.run(ctx, MINIMAL_INPUT);

    await capability.rollback?.(ctx, MINIMAL_INPUT);

    expect(calls.at(-1)).toBe(`restore:${output.spriteId}:checkpoint=${output.checkpointId}`);
  });

  it("falls back to workspace.spriteName + comment-based restore when there is no in-process run() record for this input", async () => {
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
    // With no in-process record, there is no known checkpoint id, so this is
    // the one case that still falls back to comment-based resolution.
    await capability.rollback?.(ctx, input);

    expect(calls).toEqual([`restore:warm-sprite:comment=pre-run`]);
  });

  it("degrades to an explicit no-op (does not throw, does not call restore) when neither an in-process record nor workspace.spriteName is available (#1942 review finding 3)", async () => {
    const { sprites, calls } = makeFakeSprites(succeed);
    const capability = createRunAgentCapability(sprites);
    await expect(capability.rollback?.(ctx, MINIMAL_INPUT)).resolves.toBeUndefined();
    expect(calls.some((c) => c.startsWith("restore:"))).toBe(false);
  });

  it("honors a custom workspace.checkpointComment for the checkpoint call, but still restores by the exact recorded checkpoint id, not the comment", async () => {
    const { sprites, calls, fs } = makeFakeSprites(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
    const capability = createRunAgentCapability(sprites);
    const input: RunAgentInput = { ...MINIMAL_INPUT, workspace: { checkpointComment: "before-turn" } };

    const output = await capability.run(ctx, input);
    await capability.rollback?.(ctx, input);

    expect(calls).toContain("checkpoint:before-turn");
    expect(calls).toContain(`restore:${output.spriteId}:checkpoint=${output.checkpointId}`);
    expect(fs["/work/prompt"]).toBeUndefined(); // restore actually rewound the fs
  });

  it("rollback of run 1 restores run 1's own checkpoint, not run 2's — two runs sharing the default \"pre-run\" comment on a reused sprite (regression, #1942 review finding 1)", async () => {
    const { sprites, calls, fs } = makeFakeSprites(async (args) => {
      // Each exec mutates a run-specific marker so the two runs' post-states
      // are distinguishable.
      fs[`/work/marker-${args.cmd}`] = "done";
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const capability = createRunAgentCapability(sprites);
    const input1: RunAgentInput = {
      agent: "run1-marker",
      task: { prompt: "first" },
      workspace: { spriteName: "warm-sprite" },
    };
    const input2: RunAgentInput = {
      agent: "run2-marker",
      task: { prompt: "second" },
      workspace: { spriteName: "warm-sprite" },
    };

    const output1 = await capability.run(ctx, input1);
    const output2 = await capability.run(ctx, input2);

    // Both checkpoints share the default "pre-run" comment, and run2's
    // checkpoint (taken after run1's mutation) is the newer of the two — the
    // exact ambiguity a comment-based restore could not resolve correctly.
    expect(output1.checkpointId).not.toBe(output2.checkpointId);
    expect(fs["/work/marker-run1-marker"]).toBe("done");
    expect(fs["/work/marker-run2-marker"]).toBe("done");

    await capability.rollback?.(ctx, input1);

    // A comment-based ("pre-run") restore would have resolved to run2's
    // newer checkpoint, which already contains run1's marker — the bug this
    // regression test guards against. The fix restores run1's own checkpoint
    // (taken before run1 ran at all), so run1's marker must be gone too.
    expect(calls.at(-1)).toBe(`restore:warm-sprite:checkpoint=${output1.checkpointId}`);
    expect(fs["/work/marker-run1-marker"]).toBeUndefined();
    expect(fs["/work/marker-run2-marker"]).toBeUndefined();
    expect(fs["/work/prompt"]).toBeUndefined();
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

// ── #1943: transcript hash + attestation interop ────────────────────────────

describe("computeTranscriptDigest — deterministic hash basis (#1943)", () => {
  type TranscriptParams = Parameters<typeof computeTranscriptDigest>[0];
  const turn = { status: "completed" as const, exitCode: 0, startedAt: "2026-08-25T00:00:00Z", endedAt: "2026-08-25T00:01:00Z" };
  const base: TranscriptParams = {
    agent: "code-reviewer",
    prompt: "Review the diff.",
    turn,
    stdout: "ok\n",
    stderr: "",
    artifacts: { files: [{ path: "/work/output", digest: "sha256:" + "a".repeat(64) }] },
  };

  it("is a sha256:<hex> digest", () => {
    expect(computeTranscriptDigest(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("same turn -> same sourceRef: fully deterministic across repeated calls", () => {
    expect(computeTranscriptDigest(base)).toBe(computeTranscriptDigest({ ...base }));
  });

  it("is insensitive to wall-clock time — startedAt/endedAt are excluded from the basis by design", () => {
    const laterTurn = { ...turn, startedAt: "2099-01-01T00:00:00Z", endedAt: "2099-01-01T00:01:00Z" };
    expect(computeTranscriptDigest({ ...base, turn: laterTurn })).toBe(computeTranscriptDigest(base));
  });

  it("is insensitive to artifacts.files collection order (sorted by path before hashing)", () => {
    const twoFiles = {
      ...base,
      artifacts: {
        files: [
          { path: "b.txt", digest: "sha256:" + "b".repeat(64) },
          { path: "a.txt", digest: "sha256:" + "a".repeat(64) },
        ],
      },
    };
    const reordered = { ...twoFiles, artifacts: { files: [...twoFiles.artifacts.files].reverse() } };
    expect(computeTranscriptDigest(twoFiles)).toBe(computeTranscriptDigest(reordered));
  });

  const mutations: Array<[string, (b: TranscriptParams) => TranscriptParams]> = [
    ["agent", (b) => ({ ...b, agent: "other-agent" })],
    ["prompt", (b) => ({ ...b, prompt: b.prompt + " " })],
    ["turn.status", (b) => ({ ...b, turn: { ...b.turn, status: "failed" as const } })],
    ["turn.exitCode", (b) => ({ ...b, turn: { ...b.turn, exitCode: 1 } })],
    ["stdout", (b) => ({ ...b, stdout: b.stdout + "x" })],
    ["stderr", (b) => ({ ...b, stderr: "warning" })],
    ["artifacts.files[0].digest", (b) => ({ ...b, artifacts: { files: [{ ...b.artifacts.files[0]!, digest: "sha256:" + "f".repeat(64) }] } })],
    ["artifacts.diff", (b) => ({ ...b, artifacts: { ...b.artifacts, diff: "--- a\n+++ b\n" } })],
  ];

  it.each(mutations)("any single-byte change (%s) changes the digest — tamper-evident by construction", (_label, mutate) => {
    expect(computeTranscriptDigest(mutate(base))).not.toBe(computeTranscriptDigest(base));
  });

  it("is sensitive to image bytes, even though images are folded in as their own digest, not embedded verbatim", () => {
    const withImage = { ...base, images: [{ data: "aGVsbG8=", media_type: "image/png" as const }] };
    const withDifferentImage = { ...base, images: [{ data: "d29ybGQ=", media_type: "image/png" as const }] };
    expect(computeTranscriptDigest(withImage)).not.toBe(computeTranscriptDigest(withDifferentImage));
    expect(computeTranscriptDigest(withImage)).not.toBe(computeTranscriptDigest(base));
  });
});

describe("run() — sourceRef/attestationRef determinism and tamper-evidence end to end (#1943)", () => {
  it("two runs with byte-identical scripted turns produce the same sourceRef/attestationRef", async () => {
    const { sprites: sprites1 } = makeFakeSprites(succeed);
    const { sprites: sprites2 } = makeFakeSprites(succeed);

    const cap1 = createRunAgentCapability(sprites1);
    const cap2 = createRunAgentCapability(sprites2);

    const out1 = await cap1.run(ctx, MINIMAL_INPUT);
    const out2 = await cap2.run(ctx, MINIMAL_INPUT);

    expect(out1.provenance.sourceRef).toBe(out2.provenance.sourceRef);
    expect(out1.attestationRef).toBe(out2.attestationRef);
  });

  it("a differing prompt (one byte) produces a different sourceRef/attestationRef", async () => {
    const { sprites: sprites1 } = makeFakeSprites(succeed);
    const { sprites: sprites2 } = makeFakeSprites(succeed);
    const cap1 = createRunAgentCapability(sprites1);
    const cap2 = createRunAgentCapability(sprites2);

    const out1 = await cap1.run(ctx, MINIMAL_INPUT);
    const out2 = await cap2.run(ctx, { ...MINIMAL_INPUT, task: { prompt: MINIMAL_INPUT.task.prompt + "!" } });

    expect(out1.provenance.sourceRef).not.toBe(out2.provenance.sourceRef);
    expect(out1.attestationRef).not.toBe(out2.attestationRef);
  });

  it("a differing collected artifact (the produced output byte differs) produces a different sourceRef/attestationRef", async () => {
    const fake1 = makeFakeSprites(async () => succeed());
    const fake2 = makeFakeSprites(async () => succeed());
    // Pre-seed each fake's fs so its own exec (which never itself writes
    // /work/output — `succeed()` is a no-op body) collects a distinct artifact.
    fake1.fs["/work/output"] = "result-a";
    fake2.fs["/work/output"] = "result-b";
    const cap1 = createRunAgentCapability(fake1.sprites);
    const cap2 = createRunAgentCapability(fake2.sprites);

    const out1 = await cap1.run(ctx, MINIMAL_INPUT);
    const out2 = await cap2.run(ctx, MINIMAL_INPUT);

    expect(out1.artifacts.files[0]?.digest).not.toBe(out2.artifacts.files[0]?.digest);
    expect(out1.provenance.sourceRef).not.toBe(out2.provenance.sourceRef);
  });
});

describe("toRunAgentArchiveEntry — folds RunAgentOutput into a BuildArchiveEntry (#1943 design point 2)", () => {
  const output: RunAgentOutput = {
    spriteId: "s-1",
    checkpointId: "v1",
    turn: { status: "completed", exitCode: 0, startedAt: "2026-08-25T00:00:00Z", endedAt: "2026-08-25T00:01:00Z" },
    artifacts: { files: [{ path: "/work/output", digest: "sha256:" + "a".repeat(64) }] },
    provenance: { sourceRef: "sha256:" + "b".repeat(64), artifactDigest: "sha256:" + "a".repeat(64) },
    attestationRef: "review-agent/run-agent@sha256:" + "b".repeat(64),
  };

  it("returns an asset-kind entry, content-addressed by the transcript digest", () => {
    const entry = toRunAgentArchiveEntry("review-agent", output);
    expect(entry.kind).toBe("asset");
    expect(entry.digest).toBe("sha256:" + "b".repeat(64));
    expect(entry.path).toBe("run-agent/review-agent/s-1-turn.json");
    expect(entry.provenance).toEqual(output.provenance);
  });

  it("throws when provenance.sourceRef carries no transcript digest (extractTranscriptDigest's guard)", () => {
    const malformed: RunAgentOutput = { ...output, provenance: { sourceRef: "not-a-digest", artifactDigest: output.provenance.artifactDigest } };
    expect(() => toRunAgentArchiveEntry("review-agent", malformed)).toThrow(/does not end in a "sha256:<hex>"/);
  });
});

describe("buildRunAgentProvenanceStatement — SLSA statement over a turn (#1943 design points 3+4)", () => {
  const input: RunAgentInput = {
    agent: "code-reviewer",
    task: { prompt: "Review the diff." },
    workspace: {},
  };
  const output: RunAgentOutput = {
    spriteId: "s-1",
    checkpointId: "v1",
    turn: { status: "completed", exitCode: 0, startedAt: "2026-08-25T00:00:00Z", endedAt: "2026-08-25T00:01:00Z" },
    artifacts: { files: [{ path: "/work/output", digest: "sha256:" + "a".repeat(64) }] },
    provenance: { sourceRef: "sha256:" + "b".repeat(64), artifactDigest: "sha256:" + "a".repeat(64) },
    attestationRef: "review-agent/run-agent@sha256:" + "b".repeat(64),
  };

  it("reuses predicateType https://slsa.dev/provenance/v1 — no minted run-agent-specific predicate type", () => {
    const statement = buildRunAgentProvenanceStatement(input, output, "https://github.com/actions/runner");
    expect(statement.predicateType).toBe("https://slsa.dev/provenance/v1");
  });

  it("sets buildType to RUN_AGENT_BUILD_TYPE, distinguishing a turn from a container build", () => {
    const statement = buildRunAgentProvenanceStatement(input, output, "https://github.com/actions/runner");
    expect(statement.predicate.buildDefinition.buildType).toBe(RUN_AGENT_BUILD_TYPE);
    expect(RUN_AGENT_BUILD_TYPE).toBe("https://chant.dev/agent-turn/v1");
  });

  it("the subject is output.attestationRef, digest-qualified", () => {
    const statement = buildRunAgentProvenanceStatement(input, output, "builder");
    expect(statement.subject).toEqual([{ name: output.attestationRef, digest: { sha256: "b".repeat(64) } }]);
  });

  it("folds input.agent into externalParameters and the imperative facts into internalParameters", () => {
    const statement = buildRunAgentProvenanceStatement(input, output, "builder");
    expect(statement.predicate.buildDefinition.externalParameters).toMatchObject({ agent: "code-reviewer" });
    expect(statement.predicate.buildDefinition.internalParameters).toMatchObject({
      spriteId: "s-1",
      checkpointId: "v1",
      turnStatus: "completed",
      turnExitCode: 0,
    });
  });

  it("defaults finishedOn from turn.endedAt", () => {
    const statement = buildRunAgentProvenanceStatement(input, output, "builder");
    expect(statement.predicate.runDetails.metadata?.finishedOn).toBe(output.turn.endedAt);
  });
});
