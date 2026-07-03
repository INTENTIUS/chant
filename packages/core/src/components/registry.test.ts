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

  // `cfn-deploy` gained a real implementation in #557 (see ./verbs/apply.ts);
  // `lambda-deploy` is a non-pilot apply-family verb #557 scopes out, so it
  // remains the representative still-stubbed capability for this assertion.
  test("stub run() rejects with CapabilityNotImplementedError, naming the kind", async () => {
    const registry = createCapabilityRegistry();
    const lambdaDeploy = registry.resolve("lambda-deploy");
    await expect(
      lambdaDeploy.run({ env: "dev", component: "test" }, {} as never),
    ).rejects.toBeInstanceOf(CapabilityNotImplementedError);
    await expect(
      lambdaDeploy.run({ env: "dev", component: "test" }, {} as never),
    ).rejects.toThrow('capability "lambda-deploy" is not implemented');
  });

  test("capabilities declared with rollback also stub rollback() (still-stubbed verb)", async () => {
    const registry = createCapabilityRegistry();
    const lambdaDeploy = registry.resolve("lambda-deploy");
    expect(typeof lambdaDeploy.rollback).toBe("function");
    await expect(
      lambdaDeploy.rollback?.({ env: "dev", component: "test" }, {} as never),
    ).rejects.toBeInstanceOf(CapabilityNotImplementedError);
  });

  test("capabilities without declared rollback have none", () => {
    const registry = createCapabilityRegistry();
    expect(registry.resolve("zip-package").rollback).toBeUndefined();
  });

  // #557 gave these AWS-leaf verbs real implementations (over an injectable
  // CloudExecutor — see ./verbs/cloud-executor.ts); they are no longer stubs,
  // and `run`/`rollback` no longer throw CapabilityNotImplementedError.
  test("#557 AWS-leaf verbs are real implementations, not stubs", () => {
    const registry = createCapabilityRegistry();
    for (const kind of [
      "docker-build",
      "publish-image",
      "cfn-deploy",
      "ecs-update-service",
      "code-deploy",
      "wait-for-stack",
      "wait-steady-state",
      "wait-cluster-healthy",
    ]) {
      const capability = registry.resolve(kind);
      expect(typeof capability.run).toBe("function");
    }
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
