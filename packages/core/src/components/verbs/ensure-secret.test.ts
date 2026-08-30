/**
 * `ensure-secret` capability surface tests (#1829, epic #1365 decision 3):
 * the verb is the same engine as the `ensureSecret(...)` op builder, its
 * rollback disposition is `needs-opt-out`, and COMP003 fires on a component
 * that uses it without acknowledging the compensation gap — through the same
 * registry-derived policy map `chant lint` builds, not a hard-coded list.
 */

import { describe, expect, it, vi } from "vitest";
import type { DeployContext } from "../capability";
import { CapabilityNotImplementedError, type RollbackPolicy } from "../capability";
import { createCapabilityRegistry } from "../registry";
import { createEnsureSecretCapability, ensureSecretCapability } from "./ensure-secret";
import {
  SecretMaterial,
  SecretContractMismatchError,
  consumeSecretMaterial,
  type SecretMaterialGenerator,
  type SecretStoreAdapter,
} from "../../secret-materialization";
import { loadComponentChecks } from "../../lint/rules/comp";

const ctx: DeployContext = { env: "dev", component: "fountain" };

function fakeStore(seed?: Record<string, Record<string, string>>) {
  const secrets = new Map<string, Record<string, string>>(Object.entries(seed ?? {}));
  const adapter: SecretStoreAdapter = {
    exists: vi.fn(async (name: string) => secrets.has(name)),
    describe: vi.fn(async (name: string) => ({ keys: Object.keys(secrets.get(name) ?? {}) })),
    create: vi.fn(async (name: string, keys: readonly string[], generate: SecretMaterialGenerator) => {
      const data: Record<string, string> = {};
      for (const key of keys) data[key] = consumeSecretMaterial(await generate(key));
      secrets.set(name, data);
    }),
  };
  return { adapter, secrets };
}

describe("ensure-secret capability", () => {
  it("creates an absent secret, then treats present-and-matching as done (create fires once across reruns)", async () => {
    const { adapter } = fakeStore();
    const capability = createEnsureSecretCapability({
      store: adapter,
      generator: (key) => SecretMaterial.mint(`v:${key}`),
    });
    const first = await capability.run(ctx, { name: "app-secret", keys: ["token"] });
    const second = await capability.run(ctx, { name: "app-secret", keys: ["token"] });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("present");
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });

  it("propagates the loud mismatch from the shared engine", async () => {
    const { adapter } = fakeStore({ "app-secret": { other: "x" } });
    const capability = createEnsureSecretCapability({ store: adapter });
    await expect(capability.run(ctx, { name: "app-secret", keys: ["token"] })).rejects.toThrowError(
      SecretContractMismatchError,
    );
  });

  it("output carries names only — no field of the outcome can hold material", async () => {
    const { adapter } = fakeStore();
    const capability = createEnsureSecretCapability({
      store: adapter,
      generator: (key) => SecretMaterial.mint(`v:${key}`),
    });
    const outcome = await capability.run(ctx, { name: "app-secret", keys: ["token"] });
    expect(outcome).toEqual({ outcome: "created", name: "app-secret", keys: ["token"] });
    expect(JSON.stringify(outcome)).not.toContain("v:token");
  });

  it("is registered in the starter set as a typed stub until a provider row (#1830) wires an adapter", async () => {
    const registry = createCapabilityRegistry();
    const starter = registry.resolve("ensure-secret");
    expect(starter.rollbackPolicy).toBe("needs-opt-out");
    await expect(starter.run(ctx as never, {} as never)).rejects.toThrowError(CapabilityNotImplementedError);
  });
});

describe("COMP003 over ensure-secret", () => {
  /** The same derivation chant lint's resolveRegistryContext performs. */
  function registryRollbackPolicies(): Map<string, RollbackPolicy> {
    const registry = createCapabilityRegistry();
    const policies = new Map<string, RollbackPolicy>();
    for (const kind of registry.kinds()) {
      const capability = registry.resolve(kind);
      policies.set(kind, capability.rollbackPolicy ?? (capability.rollback ? "native" : "none-by-design"));
    }
    return policies;
  }

  const [comp003] = loadComponentChecks().filter((c) => c.id === "COMP003");

  function checkComponent(step: Record<string, unknown>) {
    const checkCtx = {
      rollbackPolicies: registryRollbackPolicies(),
      components: new Map([
        [
          "fountain",
          {
            component: {
              name: "fountain",
              dependsOn: [],
              deploy: [{ phase: "Secrets", steps: [step] }],
            },
            filePath: "fountain.component.ts",
          },
        ],
      ]),
    };
    return comp003.check(checkCtx as never);
  }

  it("flags a bare ensure-secret step — minting has no safe undo, so the gap needs an explicit opt-out", () => {
    const diagnostics = checkComponent({ kind: "ensure-secret", name: "master-key", keys: ["MASTER_SECRETS_KEY"] });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].checkId).toBe("COMP003");
    expect(diagnostics[0].message).toContain("ensure-secret");
  });

  it("accepts the step once the component acknowledges the gap via noRollback", () => {
    const diagnostics = checkComponent({
      kind: "ensure-secret",
      name: "master-key",
      keys: ["MASTER_SECRETS_KEY"],
      noRollback: "generated-once: un-creating would destroy the only copy of the material",
    });
    expect(diagnostics).toHaveLength(0);
  });
});
