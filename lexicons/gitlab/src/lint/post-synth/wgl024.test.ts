import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl024 } from "./wgl024";

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

describe("WGL024: Manual Without allow_failure", () => {
  test("check metadata", () => {
    expect(wgl024.id).toBe("WGL024");
    expect(wgl024.description).toContain("Manual");
  });

  test("flags manual job without allow_failure", () => {
    const entities = new Map<string, Declarable>([
      ["manualDeploy", new MockJob({ script: ["deploy.sh"], when: "manual" })],
    ]);
    const diags = wgl024.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("manualDeploy");
    expect(diags[0].message).toContain("block");
  });

  test("does not flag manual job with allow_failure: true", () => {
    const entities = new Map<string, Declarable>([
      ["manualDeploy", new MockJob({ script: ["deploy.sh"], when: "manual", allow_failure: true })],
    ]);
    const diags = wgl024.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-manual job", () => {
    const entities = new Map<string, Declarable>([
      ["autoJob", new MockJob({ script: ["test"] })],
    ]);
    const diags = wgl024.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("flags manual job with allow_failure: false", () => {
    const entities = new Map<string, Declarable>([
      ["manualJob", new MockJob({ script: ["test"], when: "manual", allow_failure: false })],
    ]);
    const diags = wgl024.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
  });

  test("no diagnostics on empty entities", () => {
    const diags = wgl024.check(makeCtx(new Map()));
    expect(diags).toHaveLength(0);
  });
});
