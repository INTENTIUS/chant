import { describe, test, expect } from "vitest";
import { createCapabilityRegistry, STARTER_VERB_FAMILIES } from "./registry";
import { CapabilityNotImplementedError } from "./capability";
import { stubCapability } from "./verbs/stub";

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

  // The starter set no longer carries any cloud leaf — `cfn-deploy` and the
  // rest live in the aws lexicon now — so `cfn-deploy` is genuinely unknown to
  // a core-only registry, resolving only once the aws capability plugin is
  // loaded (see ./capability-plugin-loader.ts's lexicon path).
  test("a cloud-leaf kind (cfn-deploy) is not in the core starter set", () => {
    const registry = createCapabilityRegistry();
    expect(registry.has("cfn-deploy")).toBe(false);
    expect(() => registry.resolve("cfn-deploy")).toThrow(/no capability registered for kind "cfn-deploy"/);
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

  // No starter verb is a stub any more (all implemented), but the stub
  // *mechanism* (./verbs/stub.ts) stays for third-party plugins / future verbs:
  // a stub's run()/rollback() reject with CapabilityNotImplementedError, and
  // the driver surfaces that as a failed step rather than crashing.
  test("stubCapability run()/rollback() reject with CapabilityNotImplementedError, naming the kind", async () => {
    const stub = stubCapability("some-future-verb", { rollback: true });
    await expect(stub.run({ env: "dev", component: "test" }, {} as never)).rejects.toBeInstanceOf(
      CapabilityNotImplementedError,
    );
    await expect(stub.run({ env: "dev", component: "test" }, {} as never)).rejects.toThrow(
      'capability "some-future-verb" is not implemented',
    );
    expect(typeof stub.rollback).toBe("function");
    await expect(stub.rollback?.({ env: "dev", component: "test" }, {} as never)).rejects.toBeInstanceOf(
      CapabilityNotImplementedError,
    );
  });

  test("capabilities without declared rollback have none", () => {
    const registry = createCapabilityRegistry();
    expect(registry.resolve("zip-package").rollback).toBeUndefined();
  });

  // The agnostic starter verbs are all real implementations — `run` is a real
  // function, not the stub thrower.
  test("agnostic starter verbs are real implementations, not stubs", () => {
    const registry = createCapabilityRegistry();
    for (const kind of [
      "docker-build",
      "zip-package",
      "jvm-build",
      "generate-sbom",
      "sign",
      "verify",
      "vuln-gate",
      "wait-cluster-healthy",
      "wait-endpoint",
      "health-gate",
    ]) {
      const capability = registry.resolve(kind);
      expect(typeof capability.run).toBe("function");
    }
  });

  test("family table lists exactly the agnostic starter families (cloud leaves moved to lexicons)", () => {
    expect(Object.keys(STARTER_VERB_FAMILIES).sort()).toEqual(
      ["build", "escapeHatch", "sbom", "supplyChainPolicy", "supplyChainSecurity", "waitVerify"].sort(),
    );
  });

  // #606: `generate-sbom` is a real implementation (over the injectable,
  // artifact-type-keyed SbomGenerator — see ./verbs/sbom-generator.ts),
  // defaulted to the hermetic lockfile-backed generator for dir/zip/jar
  // artifacts (#630) — `forImage` still needs a real scanner backend wired
  // in explicitly (#610).
  test("#606 generate-sbom is registered and callable (default backend is the hermetic lockfile generator, #630)", () => {
    const registry = createCapabilityRegistry();
    const capability = registry.resolve("generate-sbom");
    expect(typeof capability.run).toBe("function");
    expect(capability.rollback).toBeUndefined();
  });
});
