import { describe, expect, it } from "vitest";
import {
  AGENTCORE_ENFORCEMENT,
  describeStage,
  enforcementMode,
  enforcementStage,
  isEnforcing,
} from "./enforcement";

describe("EnforcementMode", () => {
  it("carries the two wire values AWS::BedrockAgentCore::Policy declares", () => {
    // The CloudFormation enum, verbatim: ["ACTIVE", "LOG_ONLY"], default ACTIVE.
    expect(Object.values(AGENTCORE_ENFORCEMENT).sort()).toEqual(["ACTIVE", "LOG_ONLY"]);
    expect(AGENTCORE_ENFORCEMENT.logOnly).toBe("LOG_ONLY");
    expect(AGENTCORE_ENFORCEMENT.enforce).toBe("ACTIVE");
  });

  it("maps a stage onto the wire value", () => {
    expect(enforcementMode("log-only")).toBe("LOG_ONLY");
    expect(enforcementMode("enforce")).toBe("ACTIVE");
  });

  it("round-trips a stage through the wire value", () => {
    for (const stage of ["log-only", "enforce"] as const) {
      expect(enforcementStage(enforcementMode(stage))).toBe(stage);
    }
  });

  it("reads an absent EnforcementMode as enforcing, which is AWS's default", () => {
    expect(enforcementStage(undefined)).toBe("enforce");
    expect(isEnforcing(undefined)).toBe(true);
  });

  it("says which stage reaches the gateway", () => {
    expect(isEnforcing("ACTIVE")).toBe(true);
    expect(isEnforcing("LOG_ONLY")).toBe(false);
  });

  it("explains a stage the same way everywhere", () => {
    expect(describeStage("log-only")).toMatch(/logged and do not affect the response/);
    expect(describeStage("enforce")).toMatch(/reaches the gateway/);
  });
});
