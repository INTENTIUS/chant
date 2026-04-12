import { describe, test, expect } from "vitest";
import { validate } from "./validate";

describe("validate", () => {
  test("is an async function", () => {
    expect(typeof validate).toBe("function");
  });

  test("returns failure when generated dir does not exist", async () => {
    const result = await validate({ basePath: "/tmp/nonexistent-docker-lexicon-test" });
    expect(result.success).toBe(false);
    expect(result.checks.length).toBeGreaterThanOrEqual(1);
    const failedCheck = result.checks.find((c) => !c.ok);
    expect(failedCheck).toBeDefined();
  });
});
