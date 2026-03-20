import { describe, test, expect } from "bun:test";
import { analyzeDockerCoverage, computeCoverage } from "./coverage";

describe("analyzeDockerCoverage", () => {
  test("is an async function", () => {
    expect(typeof analyzeDockerCoverage).toBe("function");
  });

  test("throws when generated dir does not exist", async () => {
    await expect(
      analyzeDockerCoverage({ basePath: "/tmp/nonexistent-docker-lexicon-test" }),
    ).rejects.toThrow();
  });
});

describe("computeCoverage", () => {
  test("is a function", () => {
    expect(typeof computeCoverage).toBe("function");
  });

  test("handles a minimal lexicon JSON", () => {
    const minimal = JSON.stringify({
      Service: {
        resourceType: "Docker::Compose::Service",
        kind: "resource",
        description: "A service",
        properties: {},
      },
    });
    const report = computeCoverage(minimal);
    expect(report).toBeDefined();
  });
});
