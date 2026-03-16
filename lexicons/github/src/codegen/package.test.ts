import { describe, test, expect } from "bun:test";
import { packageLexicon } from "./package";

describe("package pipeline", () => {
  test("packageLexicon function is exported and callable", () => {
    expect(typeof packageLexicon).toBe("function");
  });
});
