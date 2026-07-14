import { describe, test, expect } from "vitest";
import { rollbackBranchName, rollbackTitle, rollbackBody } from "./rollback";

describe("rollback helpers (#873)", () => {
  test("branch name includes env and short ref", () => {
    expect(rollbackBranchName("prod", "a1b2c3d")).toBe("chant/rollback-prod-a1b2c3d");
  });

  test("branch name falls back to 'src' when env is absent", () => {
    expect(rollbackBranchName(undefined, "a1b2c3d")).toBe("chant/rollback-src-a1b2c3d");
  });

  test("title names the env and ref", () => {
    expect(rollbackTitle("prod", "v1.2.0")).toBe("rollback prod source to v1.2.0");
    expect(rollbackTitle(undefined, "v1.2.0")).toBe("rollback source to v1.2.0");
  });

  test("body references the sourceDir, ref, and the gated-apply step", () => {
    const body = rollbackBody("prod", "abc123", "src");
    expect(body).toContain("`src`");
    expect(body).toContain("`abc123`");
    expect(body).toContain("the prod environment");
    expect(body).toMatch(/approval gate|Sync|apply/i);
  });
});
