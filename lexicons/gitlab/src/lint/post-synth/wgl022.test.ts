import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl022 } from "./wgl022";

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

describe("WGL022: Missing Artifacts Expiry", () => {
  test("check metadata", () => {
    expect(wgl022.id).toBe("WGL022");
    expect(wgl022.description).toContain("artifacts");
  });

  test("flags artifacts without expire_in", () => {
    const entities = new Map<string, Declarable>([
      ["buildJob", new MockJob({
        script: ["npm build"],
        artifacts: { paths: ["dist/"] },
      })],
    ]);
    const diags = wgl022.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("buildJob");
    expect(diags[0].message).toContain("expire_in");
  });

  test("does not flag artifacts with expire_in", () => {
    const entities = new Map<string, Declarable>([
      ["buildJob", new MockJob({
        script: ["npm build"],
        artifacts: { paths: ["dist/"], expire_in: "1 week" },
      })],
    ]);
    const diags = wgl022.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag job without artifacts", () => {
    const entities = new Map<string, Declarable>([
      ["testJob", new MockJob({ script: ["npm test"] })],
    ]);
    const diags = wgl022.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("handles artifacts as declarable with props", () => {
    const entities = new Map<string, Declarable>([
      ["buildJob", new MockJob({
        script: ["npm build"],
        artifacts: { props: { paths: ["dist/"], expire_in: "30 days" } },
      })],
    ]);
    const diags = wgl022.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty entities", () => {
    const diags = wgl022.check(makeCtx(new Map()));
    expect(diags).toHaveLength(0);
  });
});
