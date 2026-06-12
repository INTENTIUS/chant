import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl034 } from "./wgl034";

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

describe("WGL034: OIDC token mintable from a merge-request pipeline", () => {
  test("flags an OIDC job reachable from merge requests", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  id_tokens:
    GCP_TOKEN:
      aud: https://iam.googleapis.com
  script:
    - echo deploy
`;
    const diags = wgl034.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL034");
    expect(diags[0].entity).toBe("deploy");
  });

  test("does not flag an OIDC job gated to a protected branch", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  id_tokens:
    GCP_TOKEN:
      aud: https://iam.googleapis.com
  script:
    - echo deploy
`;
    const diags = wgl034.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag a merge-request job without OIDC", () => {
    const yaml = `test:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - echo test
`;
    const diags = wgl034.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
