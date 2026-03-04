import { describe, test, expect } from "bun:test";
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
