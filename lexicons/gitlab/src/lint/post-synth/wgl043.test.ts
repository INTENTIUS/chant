import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl043 } from "./wgl043";

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

describe("WGL043: match-anything regex gate", () => {
  test("flags a =~ /.*/ gate", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_COMMIT_REF_NAME =~ /.*/
  script:
    - echo deploy
`;
    const diags = wgl043.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL043");
    expect(diags[0].entity).toBe("deploy");
  });

  test("does not flag a specific regex", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_COMMIT_REF_NAME =~ /^release/
  script:
    - echo deploy
`;
    const diags = wgl043.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
