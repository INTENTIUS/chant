import { describe, test, expect } from "vitest";
import { wgl017, checkInsecureRegistry } from "./wgl017";

describe("WGL017: Insecure Registry", () => {
  test("check metadata", () => {
    expect(wgl017.id).toBe("WGL017");
    expect(wgl017.description).toContain("Insecure");
  });

  test("flags docker push to HTTP registry", () => {
    const yaml = `build-image:
  script:
    - docker push http://registry.local/myimage:latest
`;
    const diags = checkInsecureRegistry(yaml);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("build-image");
    expect(diags[0].message).toContain("insecure");
  });

  test("flags docker pull from HTTP registry", () => {
    const yaml = `test-job:
  script:
    - docker pull http://insecure-registry.com/myimage
`;
    const diags = checkInsecureRegistry(yaml);
    expect(diags).toHaveLength(1);
  });

  test("does not flag HTTPS registry", () => {
    const yaml = `build-image:
  script:
    - docker push https://registry.gitlab.com/myimage:latest
`;
    const diags = checkInsecureRegistry(yaml);
    expect(diags).toHaveLength(0);
  });

  test("does not flag registry without protocol", () => {
    const yaml = `build-image:
  script:
    - docker push $CI_REGISTRY_IMAGE:latest
`;
    const diags = checkInsecureRegistry(yaml);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty yaml", () => {
    const diags = checkInsecureRegistry("");
    expect(diags).toHaveLength(0);
  });
});
