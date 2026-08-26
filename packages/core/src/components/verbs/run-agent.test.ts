/**
 * Tests `run-agent` (#1941, epic #1564 phase 1 — capability schema +
 * registry entry, ./run-agent.ts). Phase 1 ships a typed contract with
 * `run`/`rollback` as stubs, so these tests assert the schema/registration
 * surface (kind, `rollbackPolicy`, COMP003-relevant registry behavior, the
 * injectable `SpriteActivities` seam) rather than any real sprite
 * orchestration — that lands in #1942 with its own contract tests.
 */

import { describe, expect, it } from "vitest";
import { CapabilityNotImplementedError, CapabilityRegistry } from "../capability";
import {
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

  it("run() is a typed stub — rejects with CapabilityNotImplementedError, naming the kind (phase 1; real impl is #1942)", async () => {
    const capability = createRunAgentCapability();
    await expect(capability.run(ctx, MINIMAL_INPUT)).rejects.toBeInstanceOf(CapabilityNotImplementedError);
    await expect(capability.run(ctx, MINIMAL_INPUT)).rejects.toThrow('capability "run-agent" is not implemented');
  });

  it("rollback() is declared and is a typed stub — rejects with CapabilityNotImplementedError (phase 1; real impl is #1942)", async () => {
    const capability = createRunAgentCapability();
    expect(typeof capability.rollback).toBe("function");
    await expect(capability.rollback?.(ctx, MINIMAL_INPUT)).rejects.toBeInstanceOf(CapabilityNotImplementedError);
    await expect(capability.rollback?.(ctx, MINIMAL_INPUT)).rejects.toThrow(
      'capability "run-agent" is not implemented',
    );
  });

  it("accepts an injected SpriteActivities seam without changing stub behavior — the seam exists for #1942 to fill in", async () => {
    const calls: string[] = [];
    const fakeSprites: SpriteActivities = {
      create: async () => (calls.push("create"), { id: "s-1", url: "" }),
      checkpoint: async () => (calls.push("checkpoint"), { checkpointId: "v1" }),
      exec: async () => (calls.push("exec"), { stdout: "", stderr: "", exitCode: 0 }),
      restore: async () => {
        calls.push("restore");
      },
      destroy: async () => {
        calls.push("destroy");
      },
      writeFile: async () => {
        calls.push("writeFile");
      },
      readFile: async () => (calls.push("readFile"), { content: "" }),
    };

    const capability = createRunAgentCapability(fakeSprites);
    await expect(capability.run(ctx, MINIMAL_INPUT)).rejects.toBeInstanceOf(CapabilityNotImplementedError);
    // Phase 1's stub never calls into the injected seam yet (#1942 wires this up).
    expect(calls).toEqual([]);
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
});
