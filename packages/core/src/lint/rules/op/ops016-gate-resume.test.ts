/**
 * OPS016 (#3947) — a gate with `resume: true`, checked over the build output.
 */

import { describe, test, expect } from "vitest";
import { z } from "zod";
import type { PostSynthContext } from "../../post-synth";
import { DECLARABLE_MARKER } from "../../../declarable";
import { activityContract } from "../../../op/activity-contract";
import { stepOutput } from "../../../op/step-output-ref";
import { ops016 } from "./ops016-gate-resume";

function ctxWith(phases: unknown[], activityContracts?: PostSynthContext["activityContracts"]): PostSynthContext {
  const entities = new Map<string, unknown>([["upgrade", {
    [DECLARABLE_MARKER]: true,
    entityType: "Chant::Op",
    lexicon: "chant",
    kind: "resource",
    props: { name: "upgrade", overview: "test", phases },
    attributes: {},
  }]]);
  return {
    outputs: new Map([["chant", ""]]),
    entities: entities as Map<string, never>,
    buildResult: { outputs: new Map([["chant", ""]]), entities: entities as Map<string, never>, warnings: [], errors: [], sourceFileCount: 1 },
    ...(activityContracts ? { activityContracts } : {}),
  };
}

const phases = (gate: Record<string, unknown>) => [
  { name: "Prepare", steps: [{ kind: "activity", id: "token", fn: "mintToken" }, { kind: "activity", id: "plan", fn: "planIt" }] },
  { name: "Gate", steps: [{ kind: "gate", gate: "approve", plan: stepOutput("plan", "planDigest"), resume: true, ...gate }] },
  { name: "Apply", steps: [{ kind: "activity", fn: "applyIt", args: { token: stepOutput("token", "value") } }] },
];

describe("OPS016", () => {
  test("a gate that can resume passes", () => {
    expect(ops016.check(ctxWith(phases({})))).toEqual([]);
  });

  test("a gate that asks a decision point is refused, naming the op, phase and gate", () => {
    const [diag] = ops016.check(ctxWith(phases({ point: "prod-apply" })));
    expect(diag?.checkId).toBe("OPS016");
    expect(diag?.severity).toBe("error");
    expect(diag?.message).toBe('Op "upgrade", phase "Gate", gate:approve: a gate that asks a decision point can\'t resume');
  });

  test("a secret output read after the gate is refused, from the contracts the build loaded", () => {
    const contracts = new Map([["mintToken", activityContract("mintToken", z.object({}), z.object({ value: z.string() }), { secret: ["value"] })]]);
    const [diag] = ops016.check(ctxWith(phases({}), contracts));
    expect(diag?.message).toContain(`can't resume: step "token"'s output "value" is secret`);
  });
});
