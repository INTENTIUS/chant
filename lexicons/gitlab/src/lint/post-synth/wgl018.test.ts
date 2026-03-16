import { describe, test, expect } from "bun:test";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl018 } from "./wgl018";

class MockJob implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "gitlab";
  readonly entityType = "GitLab::CI::Job";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

function makeCtx(entities: Map<string, Declarable>): PostSynthContext {
  return {
    outputs: new Map(),
    entities,
    buildResult: {
      outputs: new Map(),
      entities,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("WGL018: Missing Timeout", () => {
  test("check metadata", () => {
    expect(wgl018.id).toBe("WGL018");
    expect(wgl018.description).toContain("timeout");
  });

  test("flags job without timeout", () => {
    const entities = new Map<string, Declarable>([
      ["buildJob", new MockJob({ script: ["npm build"] })],
    ]);
    const diags = wgl018.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("buildJob");
  });

  test("does not flag job with timeout", () => {
    const entities = new Map<string, Declarable>([
      ["buildJob", new MockJob({ script: ["npm build"], timeout: "10 minutes" })],
    ]);
    const diags = wgl018.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("flags multiple jobs without timeout", () => {
    const entities = new Map<string, Declarable>([
      ["job1", new MockJob({ script: ["test"] })],
      ["job2", new MockJob({ script: ["build"] })],
    ]);
    const diags = wgl018.check(makeCtx(entities));
    expect(diags).toHaveLength(2);
  });

  test("no diagnostics on empty entities", () => {
    const diags = wgl018.check(makeCtx(new Map()));
    expect(diags).toHaveLength(0);
  });
});
