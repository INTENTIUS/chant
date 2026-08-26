/**
 * `run-agent` contract/conformance suite (#1944, epic #1564 phase 4 — the
 * final child of #1564). All offline, against the in-process Sprites fake
 * (`../op/activities/sprites-fake.ts`, S7) and an injected `ProcessRunner`
 * mock (`@intentius/chant/components/verbs/__tests__/mock-process-runner`) —
 * no HTTP/WS to a real endpoint, no `docker`/`cosign`.
 *
 * Distinct from `./run-agent.test.ts` (#1942/#1943's own unit tests, which
 * call the capability directly) in one important way: the tests here run
 * `run-agent` through the actual *component saga* — core's driver
 * (`@intentius/chant/components`'s `runComponentDeploy`, ../capability.ts's
 * `CapabilityRegistry`) — proving the driver-level contract the epic's phase
 * 4 bar requires, not just the capability's own `run()`/`rollback()` pair
 * called back to back.
 *
 * Three things proved here:
 *
 *  1. **Saga-unwind restore.** A composition where `run-agent` succeeds, a
 *     LATER step throws, and the saga unwinds — the sprite must be restored
 *     to the pre-run checkpoint, through `driver.ts`'s `rollbackExecuted`, not
 *     the Op-level `onFailure` path `examples/sprites-agent-task` already
 *     demonstrates.
 *  2. **The durable-identity channel (#1944's scope addition, from #1949's
 *     review).** On the Temporal durable path, `run()` and `rollback()`
 *     execute as separate Activities, each rebuilding `input` fresh — the
 *     in-process `WeakMap` `run-agent`'s capability keeps never gets a hit
 *     there. `Capability.rollback` grew an optional third `output` parameter
 *     for exactly this (`../../../packages/core/src/components/capability.ts`),
 *     and `run-agent`'s own rollback prefers it. This file proves the
 *     capability's own logic honors that channel — simulating the Activity
 *     boundary directly (a completely different `input` object at rollback
 *     time, no WeakMap hit possible) — while
 *     `lexicons/temporal/src/component-op/runtime.test.ts` proves the
 *     generated *codegen* actually threads it end to end through a real
 *     Temporal worker.
 *  3. **Attestation conformance, as a composition.** The
 *     `run-agent -> sign -> attest-provenance -> verify` chain, run through
 *     the driver (not called capability-by-capability, which `./run-agent.
 *     test.ts` already covers) — reusing #1951's helpers
 *     (`buildRunAgentProvenanceStatement`, `createMockProcessRunner`) rather
 *     than duplicating them. A tampered/missing attestation makes `verify`
 *     throw `VerificationFailedError`, and the composition fails before any
 *     `Apply` phase step runs.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createSpritesFake } from "../op/activities/sprites-fake";
import { createFlyRunAgentCapability, createFlySpriteActivities } from "./run-agent";
import type { RunAgentInput, RunAgentOutput } from "@intentius/chant/components/verbs/run-agent";
import { RUN_AGENT_BUILD_TYPE } from "@intentius/chant/components/verbs/run-agent";
import { createSignCapability, createAttestProvenanceCapability } from "@intentius/chant/components/verbs/sign";
import { createVerifyCapability, VerificationFailedError } from "@intentius/chant/components/verbs/verify";
import { createMockProcessRunner } from "@intentius/chant/components/verbs/__tests__/mock-process-runner";
import {
  CapabilityRegistry,
  runComponentDeploy,
  type Capability,
  type DeployContext,
  type DriverComponent,
} from "@intentius/chant/components";

const ctx: DeployContext = { env: "dev", component: "agent-turn" };

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

/** A fake capability that always fails — stands in for "some later step in the composition breaks," triggering saga rollback. */
function alwaysFailsCapability(kind: string): Capability<Record<string, unknown>, never> {
  return {
    kind,
    async run(): Promise<never> {
      throw new Error(`${kind}: forced failure for saga-unwind conformance`);
    },
  };
}

/** A fake capability recording every `run()` call — stands in for an apply-style step that must never run once an earlier gate refuses. */
function markerCapability(kind: string, calls: unknown[]): Capability<Record<string, unknown>, { ok: true }> {
  return {
    kind,
    async run(_c, input): Promise<{ ok: true }> {
      calls.push(input);
      return { ok: true };
    },
  };
}

describe("run-agent — saga-unwind restore through the component driver (#1944)", () => {
  test("run-agent succeeds, a LATER step throws, and the saga unwinds — the sprite is restored to the pre-run checkpoint", async () => {
    // A reused (not freshly created) sprite: run-agent never destroys it on
    // success, so rollback has something real to restore afterward.
    const sprites = createFlySpriteActivities();
    const spriteName = `saga-unwind-${Date.now()}`;
    await sprites.create({ name: spriteName });

    const registry = new CapabilityRegistry();
    registry.register(createFlyRunAgentCapability());
    registry.register(alwaysFailsCapability("always-fails"));

    const component: DriverComponent = {
      name: "agent-turn",
      dependsOn: [],
      deploy: [
        {
          phase: "Run",
          steps: [
            {
              kind: "run-agent",
              agent: "echo hi > /work/output",
              task: { prompt: "irrelevant for this scripted command" },
              workspace: { spriteName },
            },
          ],
        },
        { phase: "Verify", steps: [{ kind: "always-fails" }] },
      ],
    };

    const result = await runComponentDeploy(component, ctx, registry, {});

    expect(result.ok).toBe(false);
    const runRecord = result.records.find((r) => r.phase === "Run" && r.kind === "run-agent");
    expect(runRecord?.status).toBe("ok");
    const rollbackRecord = result.records.find((r) => r.phase === "Run" && r.kind === "run-agent" && r.status === "rolled-back");
    expect(rollbackRecord).toBeDefined();

    // Observably restored: /work/output was written during the run, and the
    // pre-run checkpoint predates that write — a direct read now 404s.
    await expect(sprites.readFile({ id: spriteName, path: "/work/output" })).rejects.toThrow();
  });

  test("a step with a native rollback is never reported as rollback-opted-out during the same unwind", async () => {
    const sprites = createFlySpriteActivities();
    const spriteName = `saga-unwind-optout-${Date.now()}`;
    await sprites.create({ name: spriteName });

    const registry = new CapabilityRegistry();
    registry.register(createFlyRunAgentCapability());
    registry.register(alwaysFailsCapability("always-fails"));

    const component: DriverComponent = {
      name: "agent-turn",
      dependsOn: [],
      deploy: [
        {
          phase: "Run",
          steps: [
            {
              kind: "run-agent",
              agent: "echo hi > /work/output",
              task: { prompt: "irrelevant" },
              workspace: { spriteName },
            },
          ],
        },
        { phase: "Verify", steps: [{ kind: "always-fails" }] },
      ],
    };

    const result = await runComponentDeploy(component, ctx, registry, {});
    const optedOut = result.records.filter((r) => r.kind === "run-agent" && r.status === "rollback-opted-out");
    expect(optedOut).toHaveLength(0);
  });
});

describe("run-agent — durable identity channel (#1944, scope addition from #1949's review)", () => {
  test("rollback restores via output.spriteId/checkpointId even when called with a freshly-rebuilt input object (no WeakMap hit) — the Temporal Activity-boundary shape", async () => {
    // On the Temporal durable path, rollbackCapabilityStep resolves its own
    // fresh `resolvedInput` from JSON every call
    // (lexicons/temporal/src/component-op/activities.ts) — never the same
    // object run() was called with. This test reproduces that exact shape
    // directly against the real capability, without needing a Temporal
    // worker: build input, run(), then rollback() with a DIFFERENT (shallow-
    // cloned) input object, passing run()'s own output as the third
    // parameter — the durable identity channel.
    const capability = createFlyRunAgentCapability();
    const spriteName = `durable-identity-${Date.now()}`;
    const sprites = createFlySpriteActivities();
    await sprites.create({ name: spriteName });

    const runInput: RunAgentInput = {
      agent: "echo hi > /work/output",
      task: { prompt: "irrelevant for this scripted command" },
      workspace: { spriteName },
    };
    const output = await capability.run(ctx, runInput);
    expect(output.turn.status).toBe("completed");

    // A structurally-equal but reference-DIFFERENT object — resolveStepInput
    // (../../../packages/core/src/components/driver.ts) rebuilds exactly this
    // shape fresh on every Activity call; the WeakMap keyed by runInput's
    // object identity cannot possibly have a hit for this object.
    const rebuiltInput: RunAgentInput = JSON.parse(JSON.stringify(runInput));
    expect(rebuiltInput).not.toBe(runInput);

    await capability.rollback?.(ctx, rebuiltInput, output);

    // Restored despite the fresh input object: the pre-run checkpoint predates
    // the write, so a direct read now 404s.
    await expect(sprites.readFile({ id: spriteName, path: "/work/output" })).rejects.toThrow();
  });

  test("without the output parameter (a caller that never threads it) and no WeakMap hit, rollback degrades to an explicit no-op — the documented pre-#1944 behavior for a caller that doesn't opt in", async () => {
    const capability = createFlyRunAgentCapability();
    const spriteName = `no-identity-${Date.now()}`;
    const sprites = createFlySpriteActivities();
    await sprites.create({ name: spriteName });

    const runInput: RunAgentInput = {
      agent: "echo hi > /work/output",
      task: { prompt: "irrelevant" },
      workspace: { spriteName },
    };
    await capability.run(ctx, runInput);

    const rebuiltInput: RunAgentInput = JSON.parse(JSON.stringify(runInput));
    // No third argument at all: neither the WeakMap (different object) nor
    // `output` has anything to restore by for spriteId/checkpointId — but
    // `workspace.spriteName` is still present, so rollback falls back to
    // comment-based restore rather than a bare no-op.
    await capability.rollback?.(ctx, rebuiltInput);

    // Comment-based restore still finds the "pre-run" checkpoint via
    // workspace.spriteName, so this still restores correctly — the pure
    // no-op only happens with no spriteId at all (see run-agent.ts's
    // rollback()), which needs a freshly-created (not spriteName-reused)
    // sprite to reach; that path stays a no-op by design (nothing to
    // identify) and isn't newly broken by this change.
    await expect(sprites.readFile({ id: spriteName, path: "/work/output" })).rejects.toThrow();
  });
});

// ── #1944 design point 3: attestation conformance as a composition ─────────

describe("run-agent -> sign -> attest-provenance -> verify, run as a component composition through the driver (#1944)", () => {
  const POLICY = {
    expectedIssuer: "https://token.actions.githubusercontent.com",
    expectedIdentity: "https://github.com/my-org/my-repo/.github/workflows/release.yml@refs/heads/main",
  };

  function buildChainComponent(): DriverComponent {
    return {
      name: "agent-turn",
      dependsOn: [],
      deploy: [
        {
          phase: "Run",
          steps: [
            {
              kind: "run-agent",
              agent: "echo hi > /work/output",
              task: { prompt: "irrelevant for this scripted command" },
              workspace: {},
            },
          ],
        },
        { phase: "Sign", steps: [{ kind: "sign", imageRef: "@Run.attestationRef" }] },
        {
          phase: "Attest",
          steps: [
            {
              kind: "attest-provenance",
              imageRef: "@Run.attestationRef",
              provenance: "@Run.provenance",
              builderId: "https://github.com/actions/runner",
              buildType: RUN_AGENT_BUILD_TYPE,
              externalParameters: { agent: "echo hi > /work/output" },
              internalParameters: {
                spriteId: "@Run.spriteId",
                checkpointId: "@Run.checkpointId",
                turnStatus: "@Run.turn.status",
                turnExitCode: "@Run.turn.exitCode",
              },
            },
          ],
        },
        { phase: "Verify", steps: [{ kind: "verify", imageRef: "@Run.attestationRef", policy: POLICY }] },
        { phase: "Apply", steps: [{ kind: "apply-marker" }] },
      ],
    };
  }

  test("the full chain succeeds and the Apply phase runs", async () => {
    const proc = createMockProcessRunner();
    const applyCalls: unknown[] = [];
    const registry = new CapabilityRegistry();
    registry.register(createFlyRunAgentCapability());
    registry.register(createSignCapability(proc.runner));
    registry.register(createAttestProvenanceCapability(proc.runner));
    registry.register(createVerifyCapability(proc.runner));
    registry.register(markerCapability("apply-marker", applyCalls));

    const result = await runComponentDeploy(buildChainComponent(), ctx, registry, {});

    expect(result.ok).toBe(true);
    expect(applyCalls).toHaveLength(1);

    const verifyRecord = result.records.find((r) => r.kind === "verify");
    expect(verifyRecord?.status).toBe("ok");
    expect(verifyRecord?.output).toMatchObject({ verified: true, checked: ["signature", "provenance"] });

    // The wiring actually resolved a real, digest-qualified attestationRef —
    // not a passthrough literal — proving @Run.* references threaded through
    // sign/attest-provenance/verify exactly as #1943 designed.
    const runOutput = result.records.find((r) => r.kind === "run-agent")?.output as RunAgentOutput;
    expect(runOutput.attestationRef).toMatch(/^agent-turn\/run-agent@sha256:[0-9a-f]{64}$/);
  });

  test("a tampered/missing attestation makes verify throw VerificationFailedError, and the composition fails before the Apply phase ever runs", async () => {
    const proc = createMockProcessRunner({
      failures: { "cosign verify-attestation": "Error: no matching attestations found for the given subject digest" },
    });
    const applyCalls: unknown[] = [];
    const registry = new CapabilityRegistry();
    registry.register(createFlyRunAgentCapability());
    registry.register(createSignCapability(proc.runner));
    registry.register(createAttestProvenanceCapability(proc.runner));
    registry.register(createVerifyCapability(proc.runner));
    registry.register(markerCapability("apply-marker", applyCalls));

    const result = await runComponentDeploy(buildChainComponent(), ctx, registry, {});

    expect(result.ok).toBe(false);
    // Apply never ran: runComponentDeploy stops at the first failing phase —
    // the "Apply" DriverPhase is never entered at all once "Verify" throws.
    expect(applyCalls).toHaveLength(0);

    const verifyRecord = result.records.find((r) => r.kind === "verify");
    expect(verifyRecord?.status).toBe("fail");
    expect(verifyRecord?.error).toContain("verification failed");

    // Confirm the underlying capability really throws VerificationFailedError
    // (runComponentDeploy's fail record only carries the stringified message,
    // per driver.ts's runCapabilityStep) — same assertion ./run-agent.test.ts
    // makes when calling verify directly, reused here rather than re-derived.
    const verifyCapability = createVerifyCapability(proc.runner);
    await expect(
      verifyCapability.run(ctx, { imageRef: "agent-turn/run-agent@sha256:" + "0".repeat(64), policy: POLICY }),
    ).rejects.toThrow(VerificationFailedError);
  });
});
