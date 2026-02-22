import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl013, checkInvalidNeeds } from "./wgl013";

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

describe("WGL013: Invalid needs: Target", () => {
  test("check metadata", () => {
    expect(wgl013.id).toBe("WGL013");
    expect(wgl013.description).toContain("needs:");
  });

  test("dangling needs target → error", () => {
    const yaml = `stages:
  - build
  - test

build:
  stage: build
  script:
    - npm run build

test:
  stage: test
  needs:
    - nonexistent
  script:
    - npm test`;
    const diags = checkInvalidNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL013");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("nonexistent");
    expect(diags[0].message).toContain("not defined");
    expect(diags[0].entity).toBe("test");
    expect(diags[0].lexicon).toBe("gitlab");
  });

  test("self-referencing needs → error", () => {
    const yaml = `stages:
  - build

build:
  stage: build
  needs:
    - build
  script:
    - npm run build`;
    const diags = checkInvalidNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL013");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("itself");
    expect(diags[0].entity).toBe("build");
  });

  test("valid needs → no diagnostic", () => {
    const yaml = `stages:
  - build
  - test

build:
  stage: build
  script:
    - npm run build

test:
  stage: test
  needs:
    - build
  script:
    - npm test`;
    const diags = checkInvalidNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("no needs → no diagnostic", () => {
    const yaml = `stages:
  - build

build:
  stage: build
  script:
    - npm run build`;
    const diags = checkInvalidNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("multiple jobs, only one with bad needs → 1 diagnostic", () => {
    const yaml = `stages:
  - build
  - test
  - deploy

build:
  stage: build
  script:
    - npm run build

test:
  stage: test
  needs:
    - build
  script:
    - npm test

deploy:
  stage: deploy
  needs:
    - nonexistent
  script:
    - ./deploy.sh`;
    const diags = checkInvalidNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("deploy");
    expect(diags[0].message).toContain("nonexistent");
  });

  test("skips check when include: is present", () => {
    const yaml = `include:
  - local: .gitlab/ci/templates.yml

stages:
  - test

test:
  stage: test
  needs:
    - from-included-file
  script:
    - npm test`;
    const diags = checkInvalidNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("multiple invalid needs → multiple diagnostics", () => {
    const yaml = `stages:
  - build

build:
  stage: build
  needs:
    - ghost1
    - ghost2
  script:
    - npm run build`;
    const diags = checkInvalidNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(2);
    expect(diags[0].message).toContain("ghost1");
    expect(diags[1].message).toContain("ghost2");
  });
});
