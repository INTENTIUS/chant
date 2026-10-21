/**
 * OPS018 (#4015): a shell step's image is pinned by digest.
 */
import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "../../post-synth";
import { DECLARABLE_MARKER } from "../../../declarable";
import { stepOutput } from "../../../op/step-output-ref";
import { ops018 } from "./ops018-shell-image-digest";
import { coreOpChecks } from "./index";

const PINNED = `node:24@sha256:${"d".repeat(64)}`;

function ctxWith(props: Record<string, unknown>): PostSynthContext {
  const entities = new Map<string, unknown>([["build", {
    [DECLARABLE_MARKER]: true,
    entityType: "Chant::Op",
    lexicon: "chant",
    kind: "resource",
    props: { name: "build", overview: "test", ...props },
    attributes: {},
  }]]);
  return {
    outputs: new Map([["chant", ""]]),
    entities: entities as Map<string, never>,
    buildResult: { outputs: new Map([["chant", ""]]), entities: entities as Map<string, never>, warnings: [], errors: [], sourceFileCount: 1 },
  };
}

const sh = (args: Record<string, unknown>) => ({ kind: "activity", fn: "shellCmd", args: { cmd: "npm test", ...args } });

describe("OPS018", () => {
  test("is one of core's Op checks", () => {
    expect(coreOpChecks().map((c) => c.id)).toContain("OPS018");
  });

  test("a pinned image and a step with no image pass", () => {
    expect(ops018.check(ctxWith({ phases: [{ name: "Build", steps: [sh({ image: PINNED }), sh({})] }] }))).toEqual([]);
  });

  test("a tag is refused, naming the Op, the phase and the fix", () => {
    const [diag, ...rest] = ops018.check(ctxWith({ phases: [{ name: "Build", steps: [sh({ image: "node:24" })] }] }));
    expect(rest).toEqual([]);
    expect(diag?.checkId).toBe("OPS018");
    expect(diag?.severity).toBe("error");
    expect(diag?.message).toBe('Op "build", phase "Build", shellCmd: image "node:24" is not pinned by digest: name it as <ref>@sha256:<digest>');
  });

  test("an image read from another step is refused, since the record could not say what ran", () => {
    const [diag] = ops018.check(ctxWith({ phases: [{ name: "Build", steps: [sh({ image: stepOutput("pick", "stdout") })] }] }));
    expect(diag?.message).toContain("image must be a literal string");
  });

  test("onFailure and effect steps are checked too", () => {
    const diags = ops018.check(ctxWith({
      phases: [{ name: "Apply", steps: [{ kind: "effect", receipt: {}, steps: [sh({ image: "alpine" })] }] }],
      onFailure: [{ name: "Rollback", steps: [sh({ image: "alpine:latest" })] }],
    }));
    expect(diags.map((d) => d.message.split(",")[1]?.trim())).toEqual(['phase "Apply"', 'phase "Rollback"']);
  });
});
