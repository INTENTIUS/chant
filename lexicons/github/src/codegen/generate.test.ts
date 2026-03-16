import { describe, test, expect } from "bun:test";
import { generate, writeGeneratedFiles } from "./generate";

describe("generate pipeline", () => {
  test("generate function is exported and callable", () => {
    expect(typeof generate).toBe("function");
  });

  test("writeGeneratedFiles function is exported", () => {
    expect(typeof writeGeneratedFiles).toBe("function");
  });
});
