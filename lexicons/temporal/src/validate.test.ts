import { test, expect } from "vitest";
import { validate } from "./validate";

test("validate passes — all 4 resources have correct entityType strings", async () => {
  const result = await validate({ verbose: false });
  expect(result.valid ?? result.failed === 0).toBe(true);
  expect(result.failed).toBe(0);
  expect(result.errors).toHaveLength(0);
});
