/**
 * op.json IR tests — chant #1289.
 *
 * Covers the issue's own verification criteria: a representative Op (phases,
 * a gate, an effect, and onFailure compensation) round-trips through op.json
 * back into an `OpConfig` that produces byte-identical `workflow.ts`;
 * serialization is deterministic; and every op.json carries a `formatVersion`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { activityContract, collectActivityContracts, type ActivityContract } from "@intentius/chant/op";
import * as ownActivityContracts from "./activity-contracts";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { phase, gate, effect, shell, kubectlApply, httpCheck } from "@intentius/chant/op";
import type { OpConfig } from "@intentius/chant/op";
import { EffectReceipt, receiptExpectation } from "@intentius/chant/effect-receipt";
import { serializeOps } from "./serializer";
import { buildOpIR, serializeOpIR, opConfigFromIR, OP_IR_FORMAT_VERSION, type OpIR, type OpIRActivityStep } from "./op-ir";

function makeOp(config: OpConfig): [string, Declarable] {
  return [
    config.name,
    {
      [DECLARABLE_MARKER]: true,
      entityType: "Temporal::Op",
      lexicon: "temporal",
      kind: "resource",
      props: config,
      attributes: {},
    } as unknown as Declarable,
  ];
}

const seeded = EffectReceipt("seeded", {
  effect: "db-seed",
  flavor: "hash",
  inputs: { file: "seed.sql" },
});

/** Representative Op: phases, a gate, an effect, and onFailure compensation. */
function representativeOp(): OpConfig {
  return {
    name: "full-deploy",
    overview: "Deploy with approval, a seeded effect, and rollback on failure",
    depends: [],
    searchAttributes: { Team: "infra" },
    phases: [
      phase("Build", [shell("npm run build")]),
      phase("Approve", [gate("approve-deploy", { timeout: "24h", description: "Release manager sign-off" })]),
      phase("Deploy", [kubectlApply("dist/infra.yaml", { profile: "longInfra" })]),
      phase("Seed", [effect(seeded, [shell("npm run db:seed")])]),
      phase("Verify", [httpCheck("https://app.example.com/healthz")]),
    ],
    onFailure: [phase("Rollback", [shell("kubectl delete -f dist/infra.yaml --ignore-not-found")])],
  };
}

describe("op.json IR (#1289)", () => {
  it("is emitted alongside workflow.ts, activities.ts, worker.ts", () => {
    const ops = new Map([makeOp({ name: "alb-deploy", overview: "o", phases: [] })]);
    const files = serializeOps(ops);
    expect(files["ops/alb-deploy/op.json"]).toBeDefined();
    expect(files["ops/alb-deploy/workflow.ts"]).toBeDefined();
  });

  it("carries a top-level formatVersion", () => {
    const ir = buildOpIR(representativeOp());
    expect(ir.formatVersion).toBe(OP_IR_FORMAT_VERSION);
    expect(typeof ir.formatVersion).toBe("string");

    const parsed = JSON.parse(serializeOpIR(representativeOp())) as OpIR;
    expect(parsed.formatVersion).toBe(OP_IR_FORMAT_VERSION);
  });

  it("two serializations of the same config are byte-identical (determinism)", () => {
    const config = representativeOp();
    expect(serializeOpIR(config)).toBe(serializeOpIR(config));
    // A structurally-equal but freshly-built config too — order of a Map/Set
    // build must not leak into key order.
    expect(serializeOpIR(representativeOp())).toBe(serializeOpIR(representativeOp()));
  });

  it("captures the full step graph: phases, gate, effect, onFailure", () => {
    const ir = buildOpIR(representativeOp());

    expect(ir.name).toBe("full-deploy");
    expect(ir.taskQueue).toBe("full-deploy"); // resolved default
    expect(ir.searchAttributes).toEqual({ Team: "infra" });

    const [build, approve, deploy, seed, verify] = ir.phases;
    expect(build.steps[0]).toMatchObject({ kind: "activity", fn: "shellCmd", profile: "fastIdempotent" });

    expect(approve.steps[0]).toMatchObject({
      kind: "gate",
      signalName: "approve-deploy",
      timeout: "24h",
      description: "Release manager sign-off",
    });

    expect(deploy.steps[0]).toMatchObject({ kind: "activity", fn: "kubectlApply", profile: "longInfra" });

    expect(seed.steps[0]).toMatchObject({
      kind: "effect",
      receipt: { name: "seeded", effect: "db-seed", flavor: "hash", inputs: { file: "seed.sql" } },
      expectation: receiptExpectation(seeded),
    });
    expect((seed.steps[0] as { steps: unknown[] }).steps).toEqual([
      { kind: "activity", fn: "shellCmd", args: { cmd: "npm run db:seed" }, profile: "fastIdempotent" },
    ]);

    expect(verify.steps[0]).toMatchObject({ kind: "activity", fn: "httpCheck", profile: "fastIdempotent" });

    expect(ir.onFailure).toHaveLength(1);
    expect(ir.onFailure[0].name).toBe("Rollback");
    expect(ir.onFailure[0].steps[0]).toMatchObject({ kind: "activity", fn: "shellCmd" });
  });

  it("embeds JSON Schema for activities with a registered contract (chant #1288 Stage 1)", () => {
    const ir = buildOpIR(representativeOp());
    // shellCmd and httpCheck both have contracts registered in ./activity-contracts.ts.
    expect(ir.activityContracts.shellCmd).toBeDefined();
    expect(ir.activityContracts.shellCmd.args).toMatchObject({ type: "object" });
    expect(ir.activityContracts.httpCheck.returns).toMatchObject({ type: "object" });
    // kubectlApply has no registered contract in this lexicon (Stage 1 is
    // deliberately partial) — no entry, not an error.
    expect(ir.activityContracts.kubectlApply).toBeUndefined();
  });

  it("embeds the resolved retry/timeout policy for every referenced profile", () => {
    const ir = buildOpIR(representativeOp());
    expect(ir.activityProfiles.fastIdempotent).toMatchObject({ startToCloseTimeout: "5m" });
    expect(ir.activityProfiles.longInfra).toMatchObject({ startToCloseTimeout: "20m", heartbeatTimeout: "60s" });
    // No step used k8sWait/humanGate/argoSync/policyCheck.
    expect(ir.activityProfiles.k8sWait).toBeUndefined();
  });

  it("round-trips through op.json into an OpConfig that generates byte-identical workflow.ts", () => {
    const original = representativeOp();
    const ir = JSON.parse(serializeOpIR(original)) as OpIR;
    const reconstructed = opConfigFromIR(ir);

    const originalWf = serializeOps(new Map([makeOp(original)]))["ops/full-deploy/workflow.ts"];
    const roundTrippedWf = serializeOps(new Map([makeOp(reconstructed)]))["ops/full-deploy/workflow.ts"];

    expect(roundTrippedWf).toBe(originalWf);
  });

  it("round-trips a minimal Op (no gate/effect/onFailure) too", () => {
    const original: OpConfig = { name: "minimal", overview: "o", phases: [phase("Only", [shell("echo hi")])] };
    const ir = JSON.parse(serializeOpIR(original)) as OpIR;
    const reconstructed = opConfigFromIR(ir);

    const originalWf = serializeOps(new Map([makeOp(original)]))["ops/minimal/workflow.ts"];
    const roundTrippedWf = serializeOps(new Map([makeOp(reconstructed)]))["ops/minimal/workflow.ts"];

    expect(roundTrippedWf).toBe(originalWf);
  });

  it("op.json is valid, parseable JSON with stable (2-space indented) formatting", () => {
    const text = serializeOpIR(representativeOp());
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('  "formatVersion"');
  });

  it("handles contracts with transforms gracefully (skips JSON-Schema-incompatible activities)", () => {
    // Build an Op that uses both a compatible activity (shellCmd) and one with a
    // transform schema (testTransformActivity). The compatible one should appear
    // in activityContracts; the transform-based one should be skipped gracefully
    // but still present in the step graph. The transform contract is injected via
    // buildOpIR's contractRegistry parameter — it is not a real registered contract.
    const registry = new Map<string, ActivityContract>();
    collectActivityContracts(ownActivityContracts as Record<string, unknown>, registry);
    registry.set(
      "testTransformActivity",
      activityContract("testTransformActivity", z.strictObject({ value: z.string().transform((s) => s.length) })),
    );
    const config: OpConfig = {
      name: "test-with-transform",
      overview: "Test Op using a schema with transform and a normal schema",
      phases: [
        phase("Run", [
          shell("echo compatible"),
          { kind: "activity", fn: "testTransformActivity", args: { value: "test" } },
        ]),
      ],
    };

    const ir = buildOpIR(config, registry);

    // shellCmd should be in activityContracts (it has a normal contract).
    expect(ir.activityContracts.shellCmd).toBeDefined();
    expect(ir.activityContracts.shellCmd.args).toMatchObject({ type: "object" });

    // testTransformActivity should NOT be in activityContracts because its schema
    // contains a transform, which z.toJSONSchema cannot serialize. But the step
    // itself should still be in the phases (the activity is not removed from the IR).
    expect(ir.activityContracts.testTransformActivity).toBeUndefined();

    // Verify the step itself is still present in the IR.
    const runPhase = ir.phases.find((p) => p.name === "Run");
    expect(runPhase).toBeDefined();
    const transformStep = runPhase?.steps.find(
      (s): s is OpIRActivityStep => s.kind === "activity" && (s as OpIRActivityStep).fn === "testTransformActivity",
    );
    expect(transformStep).toBeDefined();
    expect(transformStep?.args).toEqual({ value: "test" });
  });

  it("opConfigFromIR throws on formatVersion mismatch", () => {
    const staleIR: OpIR = {
      formatVersion: "0.9",
      name: "stale-op",
      overview: "A stale op.json from an older chant version",
      taskQueue: "stale-op",
      depends: [],
      searchAttributes: {},
      phases: [{ name: "Run", parallel: false, steps: [] }],
      onFailure: [],
      activityProfiles: {},
      activityContracts: {},
    };

    expect(() => opConfigFromIR(staleIR)).toThrow(
      /op\.json IR format mismatch: expected "1\.0", got "0\.9"/,
    );
  });
});
