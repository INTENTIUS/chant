import { describe, test, expect } from "bun:test";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl023 } from "./wgl023";

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

describe("WGL023: Overly Broad Rules", () => {
  test("check metadata", () => {
    expect(wgl023.id).toBe("WGL023");
    expect(wgl023.description).toContain("Overly broad");
  });

  test("flags single rule with only when: always", () => {
    const entities = new Map<string, Declarable>([
      ["alwaysJob", new MockJob({
        script: ["test"],
        rules: [{ when: "always" }],
      })],
    ]);
    const diags = wgl023.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("alwaysJob");
  });

  test("does not flag rule with when: always and if condition", () => {
    const entities = new Map<string, Declarable>([
      ["conditionalJob", new MockJob({
        script: ["test"],
        rules: [{ if: "$CI_COMMIT_BRANCH == 'main'", when: "always" }],
      })],
    ]);
    const diags = wgl023.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag multiple rules", () => {
    const entities = new Map<string, Declarable>([
      ["multiRuleJob", new MockJob({
        script: ["test"],
        rules: [
          { when: "always" },
          { when: "never" },
        ],
      })],
    ]);
    const diags = wgl023.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag job without rules", () => {
    const entities = new Map<string, Declarable>([
      ["simpleJob", new MockJob({ script: ["test"] })],
    ]);
    const diags = wgl023.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty entities", () => {
    const diags = wgl023.check(makeCtx(new Map()));
    expect(diags).toHaveLength(0);
  });
});
