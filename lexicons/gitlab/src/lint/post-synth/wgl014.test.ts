import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl014, checkInvalidExtends } from "./wgl014";

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

describe("WGL014: Invalid extends: Target", () => {
  test("check metadata", () => {
    expect(wgl014.id).toBe("WGL014");
    expect(wgl014.description).toContain("extends:");
  });

  test("extends nonexistent template → error", () => {
    const yaml = `stages:
  - deploy

deploy:
  stage: deploy
  extends: .nonexistent-template
  script:
    - ./deploy.sh`;
    const diags = checkInvalidExtends(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL014");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain(".nonexistent-template");
    expect(diags[0].message).toContain("not defined");
    expect(diags[0].entity).toBe("deploy");
    expect(diags[0].lexicon).toBe("gitlab");
  });

  test("extends existing hidden job → no diagnostic", () => {
    const yaml = `.deploy-template:
  image: alpine
  script:
    - echo "template"

deploy:
  stage: deploy
  extends: .deploy-template
  script:
    - ./deploy.sh`;
    const diags = checkInvalidExtends(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("no extends → no diagnostic", () => {
    const yaml = `stages:
  - build

build:
  stage: build
  script:
    - npm run build`;
    const diags = checkInvalidExtends(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("skips check when include: is present", () => {
    const yaml = `include:
  - local: .gitlab/ci/templates.yml

deploy:
  stage: deploy
  extends: .deploy-template
  script:
    - ./deploy.sh`;
    const diags = checkInvalidExtends(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("multiple extends targets, one invalid → 1 diagnostic", () => {
    const yaml = `.base:
  image: alpine

deploy:
  stage: deploy
  extends: [.base, .missing]
  script:
    - ./deploy.sh`;
    const diags = checkInvalidExtends(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain(".missing");
  });
});
