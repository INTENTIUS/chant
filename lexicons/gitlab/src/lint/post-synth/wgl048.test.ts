import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl048 } from "./wgl048";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["gitlab", yaml]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["gitlab", yaml]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("WGL048: pipeline without a name", () => {
  test("flags a workflow: block with no name", () => {
    const yaml = `workflow:
  rules:
    - if: $CI_COMMIT_BRANCH

build:
  script:
    - make
`;
    const diags = wgl048.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL048");
  });

  test("does not flag a named workflow", () => {
    const yaml = `workflow:
  name: My Pipeline
  rules:
    - if: $CI_COMMIT_BRANCH

build:
  script:
    - make
`;
    const diags = wgl048.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag a pipeline with no workflow block", () => {
    const yaml = `build:
  script:
    - make
`;
    const diags = wgl048.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
