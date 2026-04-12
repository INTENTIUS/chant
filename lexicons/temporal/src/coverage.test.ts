import { test, expect } from "vitest";
import { analyze } from "./coverage";

test("coverage is 100% — all 4 resources are hand-written", () => {
  const result = analyze();
  expect(result.total).toBe(4);
  expect(result.covered).toBe(4);
  expect(result.missing).toHaveLength(0);
});
