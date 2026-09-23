/**
 * OPS015 (#2508) — a gate's approval block, checked over the build output.
 */

import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "../../post-synth";
import { DECLARABLE_MARKER } from "../../../declarable";
import { gatePolicyVersion } from "../../../op/gate-approval";
import { ops015 } from "./ops015-gate-approval";

const TEXT = "permit (principal, action, resource);\n";
const POLICY = { kind: "gate-policy", lexicon: "cedar", name: "ship", version: gatePolicyVersion(TEXT), text: TEXT };

function ctxWith(phases: unknown[], onFailure?: unknown[]): PostSynthContext {
  const entities = new Map<string, unknown>([["release", {
    [DECLARABLE_MARKER]: true,
    entityType: "Chant::Op",
    lexicon: "chant",
    kind: "resource",
    props: { name: "release", overview: "test", phases, ...(onFailure ? { onFailure } : {}) },
    attributes: {},
  }]]);
  return {
    outputs: new Map([["chant", ""]]),
    entities: entities as Map<string, never>,
    buildResult: { outputs: new Map([["chant", ""]]), entities: entities as Map<string, never>, warnings: [], errors: [], sourceFileCount: 1 },
  };
}

const gateStep = (approval: unknown) => ({ kind: "gate", gate: "ship", approval });

describe("OPS015", () => {
  test("a well-formed approval block passes", () => {
    const ctx = ctxWith([{ name: "Apply", steps: [gateStep({ quorum: { count: 2 }, policy: POLICY, mode: "enforce" })] }]);
    expect(ops015.check(ctx)).toEqual([]);
  });

  test("a gate with no approval block is not this rule's concern", () => {
    expect(ops015.check(ctxWith([{ name: "Apply", steps: [{ kind: "gate", gate: "ship" }] }]))).toEqual([]);
  });

  test("a policy that is not a gate policy set is refused, naming the op and gate", () => {
    const ctx = ctxWith([{ name: "Apply", steps: [gateStep({ policy: "dist/ship.cedar" })] }]);
    const [diag] = ops015.check(ctx);
    expect(diag?.checkId).toBe("OPS015");
    expect(diag?.severity).toBe("error");
    expect(diag?.message).toContain('Op "release", gate "ship"');
    expect(diag?.message).toContain("does not resolve to a gate policy set");
  });

  test("a policy whose text was edited after it was stamped is refused", () => {
    const ctx = ctxWith([{ name: "Apply", steps: [gateStep({ policy: { ...POLICY, text: "forbid (principal, action, resource);\n" } })] }]);
    expect(ops015.check(ctx)[0]?.message).toContain("not the digest of its text");
  });

  test("reports every problem, including a gate nested in an effect step and one in onFailure", () => {
    const ctx = ctxWith(
      [{ name: "Apply", steps: [{ kind: "effect", receipt: {}, steps: [gateStep({ quorum: { count: 0 }, mode: "enforce" })] }] }],
      [{ name: "Rollback", steps: [gateStep({ mode: "sometimes" })] }],
    );
    const messages = ops015.check(ctx).map((d) => d.message);
    expect(messages).toHaveLength(3);
    expect(messages.join("\n")).toContain("quorum.count");
    expect(messages.join("\n")).toContain("needs an `approval.policy`");
    expect(messages.join("\n")).toContain("approval.mode");
  });
});
