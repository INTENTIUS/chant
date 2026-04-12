import { describe, test, expect } from "vitest";
import { wgl020, checkDuplicateJobNames } from "./wgl020";

describe("WGL020: Duplicate Job Names", () => {
  test("check metadata", () => {
    expect(wgl020.id).toBe("WGL020");
    expect(wgl020.description).toContain("Duplicate");
  });

  test("flags duplicate job names", () => {
    const yaml = `build-app:
  script:
    - npm build

build-app:
  script:
    - npm run build
`;
    const diags = checkDuplicateJobNames(yaml);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("build-app");
    expect(diags[0].message).toContain("2 times");
  });

  test("does not flag unique job names", () => {
    const yaml = `build-app:
  script:
    - npm build

test-app:
  script:
    - npm test
`;
    const diags = checkDuplicateJobNames(yaml);
    expect(diags).toHaveLength(0);
  });

  test("ignores reserved keys", () => {
    const yaml = `stages:
  - build

variables:
  FOO: bar
`;
    const diags = checkDuplicateJobNames(yaml);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty yaml", () => {
    const diags = checkDuplicateJobNames("");
    expect(diags).toHaveLength(0);
  });
});
