import { describe, test, expect } from "vitest";
import { GitHub, Runner } from "./variables";

describe("GitHub context variables", () => {
  test("GitHub.Ref resolves to github.ref expression", () => {
    expect(GitHub.Ref.toString()).toBe("${{ github.ref }}");
  });

  test("GitHub.Sha resolves to github.sha expression", () => {
    expect(GitHub.Sha.toString()).toBe("${{ github.sha }}");
  });

  test("GitHub.Actor resolves to github.actor expression", () => {
    expect(GitHub.Actor.toString()).toBe("${{ github.actor }}");
  });

  test("GitHub has all expected properties", () => {
    const keys = Object.keys(GitHub);
    expect(keys).toContain("Ref");
    expect(keys).toContain("Sha");
    expect(keys).toContain("Actor");
    expect(keys).toContain("Repository");
    expect(keys).toContain("EventName");
    expect(keys).toContain("Token");
    expect(keys).toContain("Workspace");
    expect(keys.length).toBe(25);
  });
});

describe("Runner context variables", () => {
  test("Runner.Os resolves to runner.os expression", () => {
    expect(Runner.Os.toString()).toBe("${{ runner.os }}");
  });

  test("Runner.Arch resolves to runner.arch expression", () => {
    expect(Runner.Arch.toString()).toBe("${{ runner.arch }}");
  });

  test("Runner has all expected properties", () => {
    const keys = Object.keys(Runner);
    expect(keys).toContain("Os");
    expect(keys).toContain("Arch");
    expect(keys).toContain("Name");
    expect(keys).toContain("Temp");
    expect(keys).toContain("ToolCache");
    expect(keys.length).toBe(5);
  });
});
