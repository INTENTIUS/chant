import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl037 } from "./wgl037";

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

describe("WGL037: regex gate on untrusted ref", () => {
  test("flags a =~ gate on the ref name", () => {
    const yaml = `deploy:
  stage: deploy
  rules:
    - if: $CI_COMMIT_REF_NAME =~ /^release/
  script:
    - ./deploy.sh
`;
    const diags = wgl037.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL037");
    expect(diags[0].entity).toBe("deploy");
  });

  test("does not flag an exact == match", () => {
    const yaml = `deploy:
  stage: deploy
  rules:
    - if: $CI_COMMIT_REF_NAME == "main"
  script:
    - ./deploy.sh
`;
    const diags = wgl037.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
