import { describe, test, expect } from "bun:test";
import {
  analyzeGitHubCoverage,
  computeCoverage,
  overallPct,
  formatSummary,
  formatVerbose,
  checkThresholds,
} from "./coverage";

describe("coverage module", () => {
  test("analyzeGitHubCoverage is exported and callable", () => {
    expect(typeof analyzeGitHubCoverage).toBe("function");
  });

  test("re-exports from core are functions", () => {
    expect(typeof computeCoverage).toBe("function");
    expect(typeof overallPct).toBe("function");
    expect(typeof formatSummary).toBe("function");
    expect(typeof formatVerbose).toBe("function");
    expect(typeof checkThresholds).toBe("function");
  });
});
