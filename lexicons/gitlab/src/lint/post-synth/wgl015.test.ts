import { describe, test, expect } from "bun:test";
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
