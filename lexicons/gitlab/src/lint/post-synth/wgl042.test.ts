import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl042 } from "./wgl042";

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

describe("WGL042: unreachable rules after unconditional match", () => {
  test("flags a rule after an unconditional catch-all", () => {
    const yaml = `deploy:
  rules:
    - when: always
    - if: $CI_COMMIT_BRANCH == "main"
  script:
    - echo deploy
`;
    const diags = wgl042.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL042");
    expect(diags[0].entity).toBe("deploy");
  });

  test("does not flag a trailing when: never default", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
    - when: never
  script:
    - echo deploy
`;
    const diags = wgl042.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
