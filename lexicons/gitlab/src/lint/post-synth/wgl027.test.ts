import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl027 } from "./wgl027";

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

describe("WGL027: Empty Script", () => {
  test("check metadata", () => {
    expect(wgl027.id).toBe("WGL027");
    expect(wgl027.description).toContain("Empty script");
  });

  test("flags empty script array", () => {
    const entities = new Map<string, Declarable>([
      ["emptyJob", new MockJob({ script: [] })],
    ]);
    const diags = wgl027.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("emptyJob");
  });

  test("flags script with only empty strings", () => {
    const entities = new Map<string, Declarable>([
      ["blankJob", new MockJob({ script: ["", "  "] })],
    ]);
    const diags = wgl027.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
  });

  test("flags empty string script", () => {
    const entities = new Map<string, Declarable>([
      ["strJob", new MockJob({ script: "" })],
    ]);
    const diags = wgl027.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
  });

  test("does not flag valid script", () => {
    const entities = new Map<string, Declarable>([
      ["validJob", new MockJob({ script: ["npm test"] })],
    ]);
    const diags = wgl027.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag job without script", () => {
    const entities = new Map<string, Declarable>([
      ["triggerJob", new MockJob({ trigger: "other-project" })],
    ]);
    const diags = wgl027.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty entities", () => {
    const diags = wgl027.check(makeCtx(new Map()));
    expect(diags).toHaveLength(0);
  });
});
