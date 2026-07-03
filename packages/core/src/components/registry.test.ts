import { describe, test, expect } from "vitest";
import { createCapabilityRegistry, STARTER_VERB_FAMILIES } from "./registry";
import { CapabilityNotImplementedError } from "./capability";

const ALL_STARTER_KINDS = Object.values(STARTER_VERB_FAMILIES).flat();

describe("createCapabilityRegistry", () => {
  test("resolves every starter verb by kind", () => {
    const registry = createCapabilityRegistry();
    for (const kind of ALL_STARTER_KINDS) {
      expect(registry.has(kind)).toBe(true);
      const capability = registry.resolve(kind);
      expect(capability.kind).toBe(kind);
      expect(typeof capability.run).toBe("function");
    }
  });

  test("kinds() lists exactly the starter set, sorted", () => {
    const registry = createCapabilityRegistry();
    expect(registry.kinds()).toEqual([...ALL_STARTER_KINDS].sort());
  });

  test("throws a friendly error for an unregistered kind", () => {
    const registry = createCapabilityRegistry();
    expect(() => registry.resolve("nonexistent-verb")).toThrow(
      /no capability registered for kind "nonexistent-verb"/,
    );
  });

  test("registering a duplicate kind throws", () => {
    const registry = createCapabilityRegistry();
    expect(() =>
      registry.register({
        kind: "docker-build",
        run: async () => ({ archivePath: "", digest: "" }),
      }),
    ).toThrow('capability "docker-build" is already registered');
  });

  test("stub run() rejects with CapabilityNotImplementedError, naming the kind", async () => {
    const registry = createCapabilityRegistry();
    const cfnDeploy = registry.resolve("cfn-deploy");
    await expect(
      cfnDeploy.run({ env: "dev", component: "test" }, {} as never),
    ).rejects.toBeInstanceOf(CapabilityNotImplementedError);
    await expect(
      cfnDeploy.run({ env: "dev", component: "test" }, {} as never),
    ).rejects.toThrow('capability "cfn-deploy" is not implemented');
  });

  test("capabilities declared with rollback also stub rollback()", async () => {
    const registry = createCapabilityRegistry();
    const cfnDeploy = registry.resolve("cfn-deploy");
    expect(typeof cfnDeploy.rollback).toBe("function");
    await expect(
      cfnDeploy.rollback?.({ env: "dev", component: "test" }, {} as never),
    ).rejects.toBeInstanceOf(CapabilityNotImplementedError);
  });

  test("capabilities without declared rollback have none", () => {
    const registry = createCapabilityRegistry();
    expect(registry.resolve("docker-build").rollback).toBeUndefined();
  });

  test("family table covers each documented family (docs/components/capabilities.mdx)", () => {
    expect(Object.keys(STARTER_VERB_FAMILIES).sort()).toEqual(
      [
        "apply",
        "build",
        "escapeHatch",
        "hostDelivery",
        "jobSubmission",
        "publish",
        "safety",
        "waitVerify",
      ].sort(),
    );
  });
});
