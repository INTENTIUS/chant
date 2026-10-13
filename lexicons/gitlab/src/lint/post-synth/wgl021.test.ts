import { describe, test, expect } from "vitest";
import { wgl021, checkUnusedVariables } from "./wgl021";

describe("WGL021: Unused Variables", () => {
  test("check metadata", () => {
    expect(wgl021.id).toBe("WGL021");
    expect(wgl021.description).toContain("Unused");
  });

  test("flags unused global variable", () => {
    const yaml = `variables:
  UNUSED_VAR: hello
  USED_VAR: world

test-job:
  script:
    - echo $USED_VAR
`;
    const diags = checkUnusedVariables(yaml);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("UNUSED_VAR");
  });

  test("does not flag used variable", () => {
    const yaml = `variables:
  NODE_ENV: production

test-job:
  script:
    - echo $NODE_ENV
`;
    const diags = checkUnusedVariables(yaml);
    expect(diags).toHaveLength(0);
  });

  test("detects braced variable references", () => {
    const yaml = `variables:
  APP_NAME: myapp

deploy-job:
  script:
    - echo \${APP_NAME}
`;
    const diags = checkUnusedVariables(yaml);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics when no global variables", () => {
    const yaml = `test-job:
  script:
    - npm test
`;
    const diags = checkUnusedVariables(yaml);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty yaml", () => {
    const diags = checkUnusedVariables("");
    expect(diags).toHaveLength(0);
  });
});

describe("WGL021: expanded variables (#3256)", () => {
  test("reads the value:/description: form by variable name", () => {
    const yaml = `variables:
  DEPLOY_ENV:
    value: staging
    description: Target environment

deploy:
  script:
    - ./deploy.sh $DEPLOY_ENV
`;
    expect(checkUnusedVariables(yaml)).toHaveLength(0);
  });

  test("reports an unused expanded variable by its name", () => {
    const yaml = `variables:
  UNUSED_ENV:
    value: staging
    description: Never read

deploy:
  script:
    - ./deploy.sh
`;
    const diags = checkUnusedVariables(yaml);
    expect(diags.map((d) => d.entity)).toEqual(["UNUSED_ENV"]);
  });
});
