import { describe, test, expect } from "vitest";
import { wgl028, checkRedundantNeeds } from "./wgl028";

describe("WGL028: Redundant Needs", () => {
  test("check metadata", () => {
    expect(wgl028.id).toBe("WGL028");
    expect(wgl028.description).toContain("Redundant");
  });

  test("flags needs pointing to earlier stage job", () => {
    const yaml = `stages:
  - build
  - test
  - deploy

build-app:
  stage: build
  script:
    - npm build

deploy-app:
  stage: deploy
  needs:
    - build-app
  script:
    - deploy.sh
`;
    const diags = checkRedundantNeeds(yaml);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("deploy-app");
    expect(diags[0].message).toContain("build-app");
    expect(diags[0].message).toContain("earlier stage");
  });

  test("does not flag needs within same stage", () => {
    const yaml = `stages:
  - build
  - test

test-a:
  stage: test
  script:
    - test-a

test-b:
  stage: test
  needs:
    - test-a
  script:
    - test-b
`;
    const diags = checkRedundantNeeds(yaml);
    expect(diags).toHaveLength(0);
  });

  test("does not flag when no stages defined", () => {
    const yaml = `build-app:
  script:
    - npm build

deploy-app:
  needs:
    - build-app
  script:
    - deploy.sh
`;
    const diags = checkRedundantNeeds(yaml);
    expect(diags).toHaveLength(0);
  });

  test("does not flag when no needs defined", () => {
    const yaml = `stages:
  - build
  - test

build-app:
  stage: build
  script:
    - npm build

test-app:
  stage: test
  script:
    - npm test
`;
    const diags = checkRedundantNeeds(yaml);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty yaml", () => {
    const diags = checkRedundantNeeds("");
    expect(diags).toHaveLength(0);
  });
});
