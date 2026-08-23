import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { k8sCapabilityPlugin, K8S_VERB_FAMILIES } from "./capability-plugin";

describe("k8sCapabilityPlugin", () => {
  test("satisfies the CapabilityPlugin contract", () => {
    expect(isCapabilityPlugin(k8sCapabilityPlugin)).toBe(true);
    expect(k8sCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("kubectl-apply");
    expect(k8sCapabilityPlugin.families?.()).toBe(K8S_VERB_FAMILIES);
  });

  test("the plugin's version is the lexicon package's own, not a literal (#1505)", () => {
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(k8sCapabilityPlugin.version).toBe(version);
    expect(k8sCapabilityPlugin.version).not.toBe("0.41.0");
  });
});
