import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl025 } from "./wgl025";

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

describe("WGL025: Missing Cache Key", () => {
  test("check metadata", () => {
    expect(wgl025.id).toBe("WGL025");
    expect(wgl025.description).toContain("cache");
  });

  test("flags cache without key", () => {
    const entities = new Map<string, Declarable>([
      ["buildJob", new MockJob({
        script: ["npm build"],
        cache: { paths: ["node_modules/"] },
      })],
    ]);
    const diags = wgl025.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("buildJob");
  });

  test("does not flag cache with key", () => {
    const entities = new Map<string, Declarable>([
      ["buildJob", new MockJob({
        script: ["npm build"],
        cache: { key: "$CI_COMMIT_REF_SLUG", paths: ["node_modules/"] },
      })],
    ]);
    const diags = wgl025.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag job without cache", () => {
    const entities = new Map<string, Declarable>([
      ["testJob", new MockJob({ script: ["npm test"] })],
    ]);
    const diags = wgl025.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("handles cache as declarable with props", () => {
    const entities = new Map<string, Declarable>([
      ["buildJob", new MockJob({
        script: ["npm build"],
        cache: { props: { key: "my-cache", paths: ["node_modules/"] } },
      })],
    ]);
    const diags = wgl025.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty entities", () => {
    const diags = wgl025.check(makeCtx(new Map()));
    expect(diags).toHaveLength(0);
  });
});
