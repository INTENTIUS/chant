import { describe, test, expect } from "bun:test";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl019 } from "./wgl019";

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

describe("WGL019: Missing Retry on Deploy Jobs", () => {
  test("check metadata", () => {
    expect(wgl019.id).toBe("WGL019");
    expect(wgl019.description).toContain("retry");
  });

  test("flags deploy job without retry", () => {
    const entities = new Map<string, Declarable>([
      ["deployApp", new MockJob({ script: ["deploy.sh"], stage: "deploy" })],
    ]);
    const diags = wgl019.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("deployApp");
  });

  test("does not flag deploy job with retry", () => {
    const entities = new Map<string, Declarable>([
      ["deployApp", new MockJob({ script: ["deploy.sh"], stage: "deploy", retry: { max: 2 } })],
    ]);
    const diags = wgl019.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-deploy job without retry", () => {
    const entities = new Map<string, Declarable>([
      ["testJob", new MockJob({ script: ["npm test"], stage: "test" })],
    ]);
    const diags = wgl019.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("recognizes staging as a deploy stage", () => {
    const entities = new Map<string, Declarable>([
      ["stagingDeploy", new MockJob({ script: ["deploy.sh"], stage: "staging" })],
    ]);
    const diags = wgl019.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
  });

  test("no diagnostics on empty entities", () => {
    const diags = wgl019.check(makeCtx(new Map()));
    expect(diags).toHaveLength(0);
  });
});
