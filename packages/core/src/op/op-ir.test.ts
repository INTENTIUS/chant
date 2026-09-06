/**
 * op.json IR tests — chant #1289, ported to core with #2118.
 *
 * The lexicon-flavoured half of the original suite (workflow.ts byte-identity,
 * this-lexicon contract coverage) stays in
 * a hosting lexicon's own op-ir suite, which now drives the same code
 * through the shim. What is here is what the IR itself promises: the `2.0`
 * shape, determinism, the injected registries, and the round trip.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { activityContract, type ActivityContract } from "./activity-contract";
import { ACTIVITY_PROFILES } from "./activity-profiles";
import { phase, gate, effect, shell, kubectlApply, httpCheck, activity } from "./builders";
import { stepOutput } from "./step-output-ref";
import type { OpConfig } from "./types";
import { EffectReceipt, receiptExpectation } from "../effect-receipt";
import {
  buildOpIR,
  serializeOpIR,
  opConfigFromIR,
  OP_IR_FORMAT_VERSION,
  type OpIR,
  type OpIRActivityStep,
} from "./op-ir";

const seeded = EffectReceipt("seeded", {
  effect: "db-seed",
  flavor: "hash",
  inputs: { file: "seed.sql" },
});

/** Representative Op: phases, labels, a gate, an effect, and onFailure compensation. */
function representativeOp(): OpConfig {
  return {
    name: "full-deploy",
    overview: "Deploy with approval, a seeded effect, and rollback on failure",
    depends: [],
    labels: { Team: "infra", Env: "staging" },
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

function contracts(): Map<string, ActivityContract> {
  return new Map<string, ActivityContract>([
    ["shellCmd", activityContract("shellCmd", z.strictObject({ cmd: z.string() }))],
    [
      "httpCheck",
      activityContract("httpCheck", z.strictObject({ url: z.string() }), z.strictObject({ status: z.number() }), {
        entities: ["url"],
      }),
    ],
  ]);
}

describe("op.json IR", () => {
  it("carries formatVersion 2.0 — the shape without taskQueue, namespace or searchAttributes (#2118)", () => {
    expect(OP_IR_FORMAT_VERSION).toBe("2.0");

    const ir = buildOpIR(representativeOp());
    expect(ir.formatVersion).toBe("2.0");
    expect(ir.labels).toEqual({ Team: "infra", Env: "staging" });
    expect(ir).not.toHaveProperty("taskQueue");
    expect(ir).not.toHaveProperty("namespace");
    expect(ir).not.toHaveProperty("searchAttributes");

    const text = serializeOpIR(representativeOp());
    expect(text).toContain('"labels"');
    expect(text).not.toContain("taskQueue");
    expect(text).not.toContain("namespace");
    expect(text).not.toContain("searchAttributes");
  });

  it("an Op with no labels gets an empty object, not a missing key", () => {
    const ir = buildOpIR({ name: "bare", overview: "o", phases: [] });
    expect(ir.labels).toEqual({});
  });

  it("carries the Op's own cadence, and omits the key when it declares none (#2120)", () => {
    const scheduled = buildOpIR({
      name: "nightly",
      overview: "o",
      phases: [],
      schedule: { cron: "0 3 * * *", overlap: "skip" },
    });
    expect(scheduled.schedule).toEqual({ cron: "0 3 * * *", overlap: "skip" });
    expect(serializeOpIR({ name: "nightly", overview: "o", phases: [], schedule: { cron: "0 3 * * *" } }))
      .toContain('"cron": "0 3 * * *"');

    expect(buildOpIR({ name: "bare", overview: "o", phases: [] })).not.toHaveProperty("schedule");
  });

  it("round-trips a scheduled Op byte-identically (#2120)", () => {
    const original: OpConfig = {
      name: "nightly",
      overview: "o",
      phases: [phase("Only", [shell("echo hi")])],
      schedule: { cron: "0 3 * * *", overlap: "skip" },
    };
    const text = serializeOpIR(original);
    const reconstructed = opConfigFromIR(JSON.parse(text) as OpIR);

    expect(reconstructed.schedule).toEqual({ cron: "0 3 * * *", overlap: "skip" });
    expect(serializeOpIR(reconstructed)).toBe(text);
  });

  it("two serializations of the same config are byte-identical (determinism)", () => {
    const config = representativeOp();
    expect(serializeOpIR(config)).toBe(serializeOpIR(config));
    expect(serializeOpIR(representativeOp())).toBe(serializeOpIR(representativeOp()));
  });

  it("captures the full step graph: phases, gate, effect, onFailure", () => {
    const ir = buildOpIR(representativeOp());

    expect(ir.name).toBe("full-deploy");
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
    expect(verify.steps[0]).toMatchObject({ kind: "activity", fn: "httpCheck", profile: "fastIdempotent" });
    expect(ir.onFailure).toHaveLength(1);
    expect(ir.onFailure[0].name).toBe("Rollback");
  });

  it("contracts are the injected registry's: empty until a caller supplies one", () => {
    const bare = buildOpIR(representativeOp());
    expect(bare.activityContracts).toEqual({});
    // The step graph is unaffected — `profile` still resolves to its effective value.
    expect((bare.phases[2].steps[0] as OpIRActivityStep).profile).toBe("longInfra");
  });

  it("embeds core's profile table for every referenced profile, and the caller's contracts", () => {
    const ir = buildOpIR(representativeOp(), contracts());

    expect(ir.activityProfiles.fastIdempotent).toEqual(ACTIVITY_PROFILES.fastIdempotent);
    expect(ir.activityProfiles.longInfra).toEqual(ACTIVITY_PROFILES.longInfra);
    // No step used k8sWait, so it does not ride along.
    expect(ir.activityProfiles.k8sWait).toBeUndefined();

    expect(ir.activityContracts.shellCmd.args).toMatchObject({ type: "object" });
    expect(ir.activityContracts.httpCheck.returns).toMatchObject({ type: "object" });
    // kubectlApply has no contract in the passed registry — no entry, not an error.
    expect(ir.activityContracts.kubectlApply).toBeUndefined();
  });

  it("resolves entity-identifying args into a step's entities and echoes the key list (#2022)", () => {
    const ir = buildOpIR(representativeOp(), contracts());
    const verify = ir.phases.find((p) => p.name === "Verify")!;
    const check = verify.steps.find((s): s is OpIRActivityStep => s.kind === "activity" && s.fn === "httpCheck")!;
    expect(check.entities).toEqual(["https://app.example.com/healthz"]);
    expect(ir.activityContracts.httpCheck.entities).toEqual(["url"]);

    const build = ir.phases.find((p) => p.name === "Build")!;
    const sh = build.steps.find((s): s is OpIRActivityStep => s.kind === "activity" && s.fn === "shellCmd")!;
    expect(sh.entities).toBeUndefined();
  });

  it("skips a contract zod cannot turn into JSON Schema, keeping the step in the graph", () => {
    const registry = contracts();
    registry.set(
      "testTransformActivity",
      activityContract("testTransformActivity", z.strictObject({ value: z.string().transform((s) => s.length) })),
    );
    const config: OpConfig = {
      name: "test-with-transform",
      overview: "A schema with a transform beside a normal one",
      phases: [
        phase("Run", [
          shell("echo compatible"),
          { kind: "activity", fn: "testTransformActivity", args: { value: "test" } },
        ]),
      ],
    };

    const ir = buildOpIR(config, registry);
    expect(ir.activityContracts.shellCmd).toBeDefined();
    expect(ir.activityContracts.testTransformActivity).toBeUndefined();

    const run = ir.phases.find((p) => p.name === "Run")!;
    const step = run.steps.find(
      (s): s is OpIRActivityStep => s.kind === "activity" && s.fn === "testTransformActivity",
    )!;
    expect(step.args).toEqual({ value: "test" });
  });

  it("round-trips through op.json back into an OpConfig that re-serializes byte-identically", () => {
    const original = representativeOp();
    const text = serializeOpIR(original, contracts());
    const reconstructed = opConfigFromIR(JSON.parse(text) as OpIR);

    expect(serializeOpIR(reconstructed, contracts())).toBe(text);
    expect(reconstructed.labels).toEqual({ Team: "infra", Env: "staging" });
  });

  it("round-trips a minimal Op (no gate, effect, onFailure or labels) too", () => {
    const original: OpConfig = { name: "minimal", overview: "o", phases: [phase("Only", [shell("echo hi")])] };
    const text = serializeOpIR(original);
    const reconstructed = opConfigFromIR(JSON.parse(text) as OpIR);

    expect(reconstructed.labels).toBeUndefined();
    expect(serializeOpIR(reconstructed)).toBe(text);
  });

  it("op.json is valid, parseable JSON with stable 2-space indentation", () => {
    const text = serializeOpIR(representativeOp());
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('  "formatVersion"');
  });

  it("opConfigFromIR throws on a formatVersion mismatch — a 1.0 op.json is not readable as 2.0", () => {
    const staleIR = {
      formatVersion: "1.0",
      name: "stale-op",
      overview: "An op.json from before the labels split",
      depends: [],
      labels: {},
      phases: [{ name: "Run", parallel: false, steps: [] }],
      onFailure: [],
      activityProfiles: {},
      activityContracts: {},
    } as OpIR;

    expect(() => opConfigFromIR(staleIR)).toThrow(
      /op\.json IR format mismatch: expected "2\.0", got "1\.0"/,
    );
  });

  it("a StepOutputRef in a step's args serializes to a stable, documented shape", () => {
    const build = activity("chantBuild", { path: "." }, { id: "build-step" });
    const config: OpConfig = {
      name: "ref-op",
      overview: "Consumes a prior step's output",
      phases: [
        phase("Build", [build]),
        phase("Deploy", [kubectlApply("dist/k8s.yaml", { context: stepOutput(build, "outputPath") })]),
      ],
    };

    const roundTripped = JSON.parse(serializeOpIR(config)) as OpIR;
    const deployStep = roundTripped.phases[1]!.steps[0] as OpIRActivityStep;
    expect(deployStep.args.context).toEqual({ kind: "step-output-ref", step: "build-step", path: "outputPath" });
    expect(Object.keys(deployStep.args.context as object).sort()).toEqual(["kind", "path", "step"]);
  });

  it("a whole-value StepOutputRef (no path) omits the path key", () => {
    const build = activity("chantBuild", { path: "." }, { id: "build-step" });
    const config: OpConfig = {
      name: "ref-op-whole",
      overview: "Consumes a prior step's whole output",
      phases: [
        phase("Build", [build]),
        phase("Deploy", [kubectlApply("dist/k8s.yaml", { context: build.out })]),
      ],
    };

    const roundTripped = JSON.parse(serializeOpIR(config)) as OpIR;
    const deployStep = roundTripped.phases[1]!.steps[0] as OpIRActivityStep;
    expect(deployStep.args.context).toEqual({ kind: "step-output-ref", step: "build-step" });
    expect("path" in (deployStep.args.context as object)).toBe(false);
  });
});
