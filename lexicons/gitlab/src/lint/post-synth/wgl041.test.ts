import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl041, tautologyReason } from "./wgl041";

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

describe("WGL041: unsound rules:if", () => {
  test("tautologyReason classifies identical operands", () => {
    expect(tautologyReason('$CI_COMMIT_BRANCH == $CI_COMMIT_BRANCH')).toContain("always true");
    expect(tautologyReason('$X != $X')).toContain("always false");
    expect(tautologyReason('$CI_COMMIT_BRANCH == "main"')).toBeUndefined();
  });

  test("flags a tautological rule condition", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_COMMIT_BRANCH
  script:
    - echo deploy
`;
    const diags = wgl041.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL041");
    expect(diags[0].entity).toBe("deploy");
  });

  test("does not flag a real condition", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  script:
    - echo deploy
`;
    const diags = wgl041.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
