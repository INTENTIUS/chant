/**
 * Generated-once materialization engine tests (#1829, epic #1365 decisions 3
 * and 6): read-then-write, present means done, mismatch fails loudly naming
 * key names and metadata keys — and no code path returns, logs, or retains
 * the generated material.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import {
  SecretMaterial,
  SecretContractMismatchError,
  consumeSecretMaterial,
  defaultSecretMaterialGenerator,
  ensureSecretMaterialization,
  type SecretMaterialGenerator,
  type SecretStoreAdapter,
  type SecretStoreDescription,
} from "./secret-materialization";

/** A recognizable plaintext no output may ever contain. */
const CANARY = "canary-s3kr3t-material";

/** Generator minting a per-key canary value, so leak assertions can grep for it. */
const canaryGenerator: SecretMaterialGenerator = (key) => SecretMaterial.mint(`${CANARY}:${key}`);

interface StoredSecret {
  data: Record<string, string>;
  metadata?: Record<string, string>;
}

/**
 * In-memory fake store. `create` consumes each key's material exactly the way
 * a real adapter writes it, so the tests can check the stored bytes without
 * any material ever traveling back through the engine.
 */
function fakeStore(seed?: Record<string, StoredSecret>) {
  const secrets = new Map<string, StoredSecret>(Object.entries(seed ?? {}));
  const adapter: SecretStoreAdapter = {
    exists: vi.fn(async (name: string) => secrets.has(name)),
    describe: vi.fn(async (name: string): Promise<SecretStoreDescription> => {
      const secret = secrets.get(name);
      if (!secret) throw new Error(`fake store: no secret "${name}"`);
      return { keys: Object.keys(secret.data), metadata: secret.metadata };
    }),
    create: vi.fn(async (name: string, keys: readonly string[], generate: SecretMaterialGenerator) => {
      const data: Record<string, string> = {};
      for (const key of keys) {
        data[key] = consumeSecretMaterial(await generate(key));
      }
      secrets.set(name, { data });
    }),
  };
  return { adapter, secrets };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureSecretMaterialization", () => {
  it("absent: mints once through the adapter and reports created", async () => {
    const { adapter, secrets } = fakeStore();
    const outcome = await ensureSecretMaterialization(
      adapter,
      { name: "master-key", keys: ["MASTER_SECRETS_KEY"] },
      canaryGenerator,
    );
    expect(outcome).toEqual({ outcome: "created", name: "master-key", keys: ["MASTER_SECRETS_KEY"] });
    expect(adapter.create).toHaveBeenCalledTimes(1);
    expect(secrets.get("master-key")?.data).toEqual({
      MASTER_SECRETS_KEY: `${CANARY}:MASTER_SECRETS_KEY`,
    });
  });

  it("present and matching: stops without any write — a rerun is byte-identical and create never fires twice", async () => {
    const { adapter, secrets } = fakeStore();
    const spec = { name: "master-key", keys: ["a", "b"] };

    await ensureSecretMaterialization(adapter, spec, canaryGenerator);
    const afterFirstRun = JSON.stringify(secrets.get("master-key"));

    // Second run of the whole ensure — the fountain-ops e2e shape.
    const outcome = await ensureSecretMaterialization(adapter, spec, canaryGenerator);
    expect(outcome.outcome).toBe("present");
    expect(adapter.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(secrets.get("master-key"))).toBe(afterFirstRun);
  });

  it("present with a missing declared key: fails loudly naming the key, never minting over the existing value", async () => {
    const { adapter, secrets } = fakeStore({
      "master-key": { data: { a: "pre-existing-value" } },
    });
    await expect(
      ensureSecretMaterialization(adapter, { name: "master-key", keys: ["a", "b"] }, canaryGenerator),
    ).rejects.toThrowError(SecretContractMismatchError);
    await expect(
      ensureSecretMaterialization(adapter, { name: "master-key", keys: ["a", "b"] }, canaryGenerator),
    ).rejects.toThrowError(/missing declared key\(s\): b/);
    expect(adapter.create).not.toHaveBeenCalled();
    expect(secrets.get("master-key")?.data).toEqual({ a: "pre-existing-value" });
  });

  it("present with an undeclared extra key: fails naming the extra key", async () => {
    const { adapter } = fakeStore({
      "master-key": { data: { a: "x", rogue: "y" } },
    });
    await expect(
      ensureSecretMaterialization(adapter, { name: "master-key", keys: ["a"] }, canaryGenerator),
    ).rejects.toThrowError(/undeclared key\(s\) present: rogue/);
  });

  it("declared metadata mismatch: fails naming the metadata KEY only, never its values", async () => {
    const { adapter } = fakeStore({
      "master-key": {
        data: { a: "x" },
        metadata: { "chant.dev/provenance": "hand-rolled" },
      },
    });
    let thrown: unknown;
    try {
      await ensureSecretMaterialization(
        adapter,
        {
          name: "master-key",
          keys: ["a"],
          metadata: { "chant.dev/provenance": "generated-once", "chant.dev/stack": "fountain" },
        },
        canaryGenerator,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SecretContractMismatchError);
    const message = (thrown as Error).message;
    expect(message).toContain("metadata key differs: chant.dev/provenance");
    expect(message).toContain("missing declared metadata key: chant.dev/stack");
    // The KEY is named; neither the declared nor the stored VALUE appears.
    expect(message).not.toContain("hand-rolled");
    expect(message).not.toContain("generated-once");
  });

  it("rejects an empty key-set — there is nothing to materialize", async () => {
    const { adapter } = fakeStore();
    await expect(
      ensureSecretMaterialization(adapter, { name: "master-key", keys: [] }, canaryGenerator),
    ).rejects.toThrowError(/at least one key/);
    expect(adapter.exists).not.toHaveBeenCalled();
  });

  it("never emits the generated material on any log or error surface", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { adapter } = fakeStore({ mismatched: { data: { wrong: "stored-value" } } });
    await ensureSecretMaterialization(adapter, { name: "fresh", keys: ["k1", "k2"] }, canaryGenerator);
    const failure = await ensureSecretMaterialization(
      adapter,
      { name: "mismatched", keys: ["right"] },
      canaryGenerator,
    ).catch((e: Error) => e);

    const captured = [logSpy, errorSpy, warnSpy, infoSpy, stdoutSpy, stderrSpy]
      .flatMap((spy) => spy.mock.calls)
      .map((call) => call.map((arg) => inspect(arg)).join(" "))
      .join("\n");
    expect(captured).not.toContain(CANARY);
    expect((failure as Error).message).not.toContain(CANARY);
    expect((failure as Error).message).not.toContain("stored-value");
  });
});

describe("SecretMaterial", () => {
  it("holds the plaintext out of reach: enumeration, JSON, string coercion, and inspect all redact", () => {
    const material = SecretMaterial.mint(CANARY);
    expect(Object.keys(material)).toEqual([]);
    expect(JSON.stringify(material)).toBe('"[secret material]"');
    expect(String(material)).toBe("[secret material]");
    expect(inspect(material)).toBe("[secret material]");
    expect(inspect({ nested: material })).not.toContain(CANARY);
  });

  it("is consumable exactly once — the adapter takes it, nothing re-reads it", () => {
    const material = SecretMaterial.mint(CANARY);
    expect(consumeSecretMaterial(material)).toBe(CANARY);
    expect(() => consumeSecretMaterial(material)).toThrowError(/already consumed/);
  });

  it("default generator mints 32 CSPRNG bytes as base64url", () => {
    const material = defaultSecretMaterialGenerator("any-key");
    expect(material).toBeInstanceOf(SecretMaterial);
    const plaintext = consumeSecretMaterial(material as SecretMaterial);
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
