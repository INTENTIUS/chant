import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl033 } from "./wgl033";

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

describe("WGL033: OIDC id_token audience scoping", () => {
  test("flags a wildcard audience", () => {
    const yaml = `deploy:
  stage: deploy
  id_tokens:
    GCP_TOKEN:
      aud: '*'
  script:
    - echo deploy
`;
    const diags = wgl033.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL033");
    expect(diags[0].entity).toBe("deploy");
  });

  test("flags an empty audience", () => {
    const yaml = `deploy:
  id_tokens:
    GCP_TOKEN:
      aud: ''
  script:
    - echo deploy
`;
    const diags = wgl033.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
  });

  test("does not flag a scoped audience", () => {
    const yaml = `deploy:
  id_tokens:
    GCP_TOKEN:
      aud: https://iam.googleapis.com
  script:
    - echo deploy
`;
    const diags = wgl033.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
