import { describe, test, expect } from "vitest";
import { flyCapabilityPlugin, FLY_VERB_FAMILIES } from "./capability-plugin";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { readFileSync } from "node:fs";

describe("flyCapabilityPlugin", () => {
  test("satisfies the CapabilityPlugin contract", () => {
    expect(isCapabilityPlugin(flyCapabilityPlugin)).toBe(true);
    expect(flyCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("run-agent");
  });

  test("the plugin's version is the lexicon package's own, not a literal (#1505)", () => {
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(flyCapabilityPlugin.version).toBe(version);
    expect(flyCapabilityPlugin.version).not.toBe("1.0.0");
  });

  test("declares run-agent under its own FLY_VERB_FAMILIES, not core's starter set", () => {
    expect(FLY_VERB_FAMILIES.agentExecution).toEqual(["run-agent"]);
    expect(flyCapabilityPlugin.families?.()).toEqual(FLY_VERB_FAMILIES);
  });

  test("the registered capability declares rollbackPolicy \"native\" with a real rollback", () => {
    const runAgent = flyCapabilityPlugin.capabilities().find((c) => c.kind === "run-agent");
    expect(runAgent?.rollbackPolicy).toBe("native");
    expect(typeof runAgent?.rollback).toBe("function");
  });
});
