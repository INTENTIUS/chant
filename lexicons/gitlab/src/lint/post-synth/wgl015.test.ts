import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl015, checkCircularNeeds } from "./wgl015";

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

describe("WGL015: Circular needs: Chain", () => {
  test("check metadata", () => {
    expect(wgl015.id).toBe("WGL015");
    expect(wgl015.description).toContain("Circular");
  });

  test("A→B→A cycle → error", () => {
    const yaml = `stages:
  - build

job-a:
  stage: build
  needs:
    - job-b
  script:
    - echo a

job-b:
  stage: build
  needs:
    - job-a
  script:
    - echo b`;
    const diags = checkCircularNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL015");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("job-a");
    expect(diags[0].message).toContain("job-b");
    expect(diags[0].message).toContain("→");
    expect(diags[0].lexicon).toBe("gitlab");
  });

  test("A→B→C→A cycle → error", () => {
    const yaml = `stages:
  - build

job-a:
  stage: build
  needs:
    - job-b
  script:
    - echo a

job-b:
  stage: build
  needs:
    - job-c
  script:
    - echo b

job-c:
  stage: build
  needs:
    - job-a
  script:
    - echo c`;
    const diags = checkCircularNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("job-a");
    expect(diags[0].message).toContain("job-b");
    expect(diags[0].message).toContain("job-c");
  });

  test("A→B, B→C (no cycle) → no diagnostic", () => {
    const yaml = `stages:
  - build

job-a:
  stage: build
  needs:
    - job-b
  script:
    - echo a

job-b:
  stage: build
  needs:
    - job-c
  script:
    - echo b

job-c:
  stage: build
  script:
    - echo c`;
    const diags = checkCircularNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("no needs at all → no diagnostic", () => {
    const yaml = `stages:
  - build

job-a:
  stage: build
  script:
    - echo a

job-b:
  stage: build
  script:
    - echo b`;
    const diags = checkCircularNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("needs referencing unknown job (no cycle) → no diagnostic", () => {
    const yaml = `stages:
  - build

job-a:
  stage: build
  needs:
    - unknown-job
  script:
    - echo a`;
    const diags = checkCircularNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

describe("WGL015: needs the old line parser dropped (#3256)", () => {
  test("finds a cycle through a need listed after an artifacts: line", () => {
    const yaml = `build:
  needs: [deploy]
  script: make

deploy:
  needs:
    - job: lint
      artifacts: true
    - job: build
  script: ./deploy.sh

lint:
  script: make lint
`;
    const diags = checkCircularNeeds(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("build");
    expect(diags[0].message).toContain("deploy");
  });

  test("finds a cycle through a job whose id starts with a capital", () => {
    const yaml = `Build:
  needs: [deploy]
  script: make

deploy:
  needs: [Build]
  script: ./deploy.sh
`;
    expect(checkCircularNeeds(makeCtx(yaml))).toHaveLength(1);
  });
});
