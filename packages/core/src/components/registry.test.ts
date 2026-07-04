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

  // `cfn-deploy` gained a real implementation in #557 (see ./verbs/apply.ts)
  // and `lambda-deploy` gained one in #558 (the fourth validation component's
  // one new capability); `run-migration` is a non-pilot apply-family verb
  // neither issue scopes, so it remains the representative still-stubbed
  // capability for this assertion.
  test("stub run() rejects with CapabilityNotImplementedError, naming the kind", async () => {
    const registry = createCapabilityRegistry();
    const runMigration = registry.resolve("run-migration");
    await expect(
      runMigration.run({ env: "dev", component: "test" }, {} as never),
    ).rejects.toBeInstanceOf(CapabilityNotImplementedError);
    await expect(
      runMigration.run({ env: "dev", component: "test" }, {} as never),
    ).rejects.toThrow('capability "run-migration" is not implemented');
  });

  test("capabilities declared with rollback also stub rollback() (still-stubbed verb)", async () => {
    const registry = createCapabilityRegistry();
    const runMigration = registry.resolve("run-migration");
    expect(typeof runMigration.rollback).toBe("function");
    await expect(
      runMigration.rollback?.({ env: "dev", component: "test" }, {} as never),
    ).rejects.toBeInstanceOf(CapabilityNotImplementedError);
  });

  test("capabilities without declared rollback have none", () => {
    const registry = createCapabilityRegistry();
    expect(registry.resolve("zip-package").rollback).toBeUndefined();
  });

  // #557 gave these AWS-leaf verbs real implementations (over an injectable
  // CloudExecutor — see ./verbs/cloud-executor.ts); #558 added `lambda-deploy`.
  // They are no longer stubs, and `run`/`rollback` no longer throw
  // CapabilityNotImplementedError.
  test("#557/#558 AWS-leaf verbs are real implementations, not stubs", () => {
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
      "lambda-deploy",
    ]) {
      const capability = registry.resolve(kind);
      expect(typeof capability.run).toBe("function");
    }
  });

  // #561 gave these two verbs real implementations (over the same injectable
  // CloudExecutor, extended with an `emr` client — see ./verbs/cloud-executor.ts)
  // so the JAR-producer -> EMR-consumer cross-component example
  // (../__fixtures__/jar-lib-producer.json / emr-job-consumer.json) can run
  // end to end against a mocked cloud. `emr-submit-step` (a different verb —
  // submit to an already-running cluster) stays a stub; #561's example only
  // needs `emr-start-job-run`.
  test("#561 job-submission/wait-verify verbs (emr-start-job-run, wait-job) are real implementations, not stubs", () => {
    const registry = createCapabilityRegistry();
    for (const kind of ["emr-start-job-run", "wait-job"]) {
      const capability = registry.resolve(kind);
      expect(typeof capability.run).toBe("function");
    }
  });

  test("family table covers each documented family (docs/components/capabilities.mdx)", () => {
    expect(Object.keys(STARTER_VERB_FAMILIES).sort()).toEqual(
      [
        "apply",
        "build",
        "sbom",
        "escapeHatch",
        "hostDelivery",
        "jobSubmission",
        "publish",
        "supplyChainSecurity",
        "supplyChainPolicy",
        "safety",
        "waitVerify",
      ].sort(),
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
