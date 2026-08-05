import { describe, test, expect } from "vitest";
import { awsCapabilityPlugin } from "./capability-plugin";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { readFileSync } from "node:fs";

describe("awsCapabilityPlugin", () => {
  test("satisfies the CapabilityPlugin contract", () => {
    expect(isCapabilityPlugin(awsCapabilityPlugin)).toBe(true);
    expect(awsCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("cfn-deploy");
  });

  test("the plugin's version is the lexicon package's own, not a literal (#1505)", () => {
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(awsCapabilityPlugin.version).toBe(version);
    expect(awsCapabilityPlugin.version).not.toBe("1.0.0");
  });
});
