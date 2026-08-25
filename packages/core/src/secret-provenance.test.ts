import { describe, test, expect } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  declareSecret,
  isSecretDeclaration,
  isCommittedEncryptedSecret,
  collectSecretDeclarations,
  SECRET_DECLARATION_MARKER,
  SECRET_DECLARATION_ENTITY_TYPE,
  SECRET_PROVENANCE_KINDS,
  type SecretDeclaration,
} from "./secret-provenance";
import { isDeclarable, type Declarable } from "./declarable";
import { build, partitionByLexicon } from "./build";
import type { Serializer } from "./serializer";

describe("declareSecret — referenced", () => {
  test("carries name, kind, and optional scope — nothing else", () => {
    const decl = declareSecret({ name: "db-password", provenance: "referenced", scope: "ns:fountain" });
    expect(decl.name).toBe("db-password");
    expect(decl.provenance).toBe("referenced");
    expect(decl.scope).toBe("ns:fountain");
    expect(decl.lexicon).toBe("chant");
    expect(decl.entityType).toBe(SECRET_DECLARATION_ENTITY_TYPE);
    expect(Object.keys(decl).sort()).toEqual(["entityType", "lexicon", "name", "provenance", "scope"]);
  });

  test("scope is optional", () => {
    const decl = declareSecret({ name: "api-token", provenance: "referenced" });
    expect("scope" in decl).toBe(false);
  });
});

describe("declareSecret — from-provider", () => {
  test("points at the provider binding, never re-models it", () => {
    const decl = declareSecret({
      name: "fountain-secrets",
      provenance: "from-provider",
      provider: { binding: "fountainInfisical", entityType: "K8s::Infisical::InfisicalSecret" },
    });
    expect(decl.provenance).toBe("from-provider");
    expect(decl.provider.binding).toBe("fountainInfisical");
    expect(decl.provider.entityType).toBe("K8s::Infisical::InfisicalSecret");
    expect(Object.isFrozen(decl.provider)).toBe(true);
  });

  test("requires a non-empty provider.binding", () => {
    expect(() =>
      declareSecret({ name: "x", provenance: "from-provider", provider: { binding: "" } }),
    ).toThrow(/provider\.binding/);
  });
});

describe("declareSecret — generated-once", () => {
  test("carries contract flags only — the declared key-set", () => {
    const decl = declareSecret({
      name: "master-secrets-key",
      provenance: "generated-once",
      keys: ["MASTER_SECRETS_KEY"],
    });
    expect(decl.provenance).toBe("generated-once");
    expect(decl.keys).toEqual(["MASTER_SECRETS_KEY"]);
    expect(Object.isFrozen(decl.keys)).toBe(true);
  });

  test("keys is optional", () => {
    const decl = declareSecret({ name: "seed", provenance: "generated-once" });
    expect("keys" in decl).toBe(false);
  });
});

describe("declareSecret — committed-encrypted", () => {
  test("records a path and nothing else — the bytes stay on disk", () => {
    const decl = declareSecret({
      name: "db-credentials",
      provenance: "committed-encrypted",
      file: "secrets/db-credentials.sops.yaml",
      encryption: "sops",
      recipients: ["age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"],
      keys: ["POSTGRES_USER", "POSTGRES_PASSWORD"],
    });
    expect(decl.provenance).toBe("committed-encrypted");
    expect(decl.file).toBe("secrets/db-credentials.sops.yaml");
    expect(decl.encryption).toBe("sops");
    expect(decl.keys).toEqual(["POSTGRES_USER", "POSTGRES_PASSWORD"]);
    expect(Object.isFrozen(decl.keys)).toBe(true);
    expect(Object.isFrozen(decl.recipients)).toBe(true);
    expect(Object.keys(decl).sort()).toEqual([
      "encryption",
      "entityType",
      "file",
      "keys",
      "lexicon",
      "name",
      "provenance",
      "recipients",
    ]);
    expect(isCommittedEncryptedSecret(decl)).toBe(true);
  });

  test("encryption defaults to sops; recipients and keys are optional", () => {
    const decl = declareSecret({
      name: "db-credentials",
      provenance: "committed-encrypted",
      file: "secrets/db.sops.yaml",
    });
    expect(decl.encryption).toBe("sops");
    expect("recipients" in decl).toBe(false);
    expect("keys" in decl).toBe(false);
  });

  test("the factory is pure — it never touches the filesystem", () => {
    // A path that does not exist anywhere declares fine: existence is checked
    // at buildRoots(), not here, which is what keeps the factory foldable.
    const decl = declareSecret({
      name: "nope",
      provenance: "committed-encrypted",
      file: "no/such/dir/nothing-here.sops.yaml",
    });
    expect(decl.file).toBe("no/such/dir/nothing-here.sops.yaml");
    expect(isSecretDeclaration(decl)).toBe(true);
  });

  test("the same input twice yields equal declarations (foldable)", () => {
    const input = {
      name: "db-credentials",
      provenance: "committed-encrypted",
      file: "secrets/db.sops.yaml",
      keys: ["A"],
    } as const;
    const a = declareSecret({ ...input });
    const b = declareSecret({ ...input });
    expect({ ...a }).toEqual({ ...b });
  });

  test("rejects a missing, absolute, or escaping path", () => {
    expect(() =>
      // @ts-expect-error — `file` is required
      declareSecret({ name: "x", provenance: "committed-encrypted" }),
    ).toThrow(/`file`/);
    expect(() =>
      declareSecret({ name: "x", provenance: "committed-encrypted", file: "" }),
    ).toThrow(/`file`/);
    expect(() =>
      declareSecret({ name: "x", provenance: "committed-encrypted", file: "/etc/shadow.yaml" }),
    ).toThrow(/repo-relative/);
    expect(() =>
      declareSecret({ name: "x", provenance: "committed-encrypted", file: "../../secrets/x.yaml" }),
    ).toThrow(/\.\./);
  });

  test("v1 restricts the path to .yaml/.yml", () => {
    expect(() =>
      declareSecret({ name: "x", provenance: "committed-encrypted", file: "secrets/x.sops.json" }),
    ).toThrow(/YAML/);
    expect(
      declareSecret({ name: "x", provenance: "committed-encrypted", file: "secrets/x.sops.YML" })
        .file,
    ).toBe("secrets/x.sops.YML");
  });

  test("rejects an unknown encryption tool", () => {
    expect(() =>
      declareSecret({
        name: "x",
        provenance: "committed-encrypted",
        file: "secrets/x.yaml",
        // @ts-expect-error — the encryption union is closed
        encryption: "gpg",
      }),
    ).toThrow(/unknown encryption/);
  });

  test("refuses a private key pasted into recipients, without echoing it", () => {
    const identity =
      "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
    let thrown: Error | undefined;
    try {
      declareSecret({
        name: "x",
        provenance: "committed-encrypted",
        file: "secrets/x.yaml",
        recipients: [identity],
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("recipients[0]");
    expect(thrown!.message).not.toContain(identity);

    expect(() =>
      declareSecret({
        name: "x",
        provenance: "committed-encrypted",
        file: "secrets/x.yaml",
        recipients: ["-----BEGIN OPENSSH PRIVATE KEY-----"],
      }),
    ).toThrow(/PRIVATE key/);
  });

  test("`ciphertext` is still forbidden — the declaration points at bytes, never carries them", () => {
    const input = {
      name: "x",
      provenance: "committed-encrypted",
      file: "secrets/x.yaml",
      ciphertext: "ENC[AES256_GCM,data:xxxx]",
    };
    let thrown: Error | undefined;
    try {
      // @ts-expect-error — `ciphertext` must not compile
      declareSecret(input);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('"ciphertext"');
    expect(thrown!.message).not.toContain("AES256_GCM");
  });
});

describe("declareSecret — value unrepresentable", () => {
  test("no declaration kind has a field that could hold material", () => {
    const decls: SecretDeclaration[] = [
      declareSecret({ name: "a", provenance: "referenced" }),
      declareSecret({ name: "b", provenance: "from-provider", provider: { binding: "p" } }),
      declareSecret({ name: "c", provenance: "generated-once", keys: ["k"] }),
      declareSecret({ name: "d", provenance: "committed-encrypted", file: "s/d.sops.yaml" }),
    ];
    for (const decl of decls) {
      for (const field of ["value", "data", "stringData", "material", "plaintext", "ciphertext"]) {
        expect(field in decl).toBe(false);
      }
      // Declared fields are immutable (the object stays extensible so
      // discovery can stamp its symbol-keyed metadata).
      expect(() => {
        (decl as { name: string }).name = "mutated";
      }).toThrow();
    }
  });

  test("a material-shaped field is rejected at runtime, naming only the key", () => {
    const input = { name: "leaky", provenance: "referenced", value: "hunter2" };
    let thrown: Error | undefined;
    try {
      // @ts-expect-error — a value field must not compile
      declareSecret(input);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('"value"');
    // The constitutional line: the error must not echo the material.
    expect(thrown!.message).not.toContain("hunter2");
  });

  test("type-level: material fields do not compile on any kind", () => {
    // @ts-expect-error — `value` is unrepresentable
    const a = () => declareSecret({ name: "a", provenance: "referenced", value: "s" });
    // @ts-expect-error — `data` is unrepresentable
    const b = () => declareSecret({ name: "b", provenance: "generated-once", data: { k: "v" } });
    const c = () =>
      // @ts-expect-error — `stringData` is unrepresentable
      declareSecret({ name: "c", provenance: "from-provider", provider: { binding: "p" }, stringData: {} });
    // Widened objects (past excess-property checks) are still rejected by the `never` fields.
    const widened = { name: "d", provenance: "referenced", value: "s" } as const;
    // @ts-expect-error — `value` stays unrepresentable through a widened object
    const d = () => declareSecret(widened);
    expect([a, b, c, d].every((f) => typeof f === "function")).toBe(true);
  });

  test("rejects an empty name and an unknown kind", () => {
    expect(() => declareSecret({ name: "", provenance: "referenced" })).toThrow(/name/);
    // @ts-expect-error — the union is closed
    expect(() => declareSecret({ name: "x", provenance: "sealed-secret" })).toThrow(/unknown provenance/);
  });
});

describe("secret declarations and the entity map", () => {
  test("a declaration is a Declarable and a SecretDeclaration; the kind set is closed", () => {
    const decl = declareSecret({ name: "a", provenance: "referenced" });
    expect(isDeclarable(decl)).toBe(true);
    expect(isSecretDeclaration(decl)).toBe(true);
    expect(isSecretDeclaration({ name: "a", provenance: "referenced" })).toBe(false);
    expect((decl as unknown as Record<symbol, unknown>)[SECRET_DECLARATION_MARKER]).toBe(true);
    expect(SECRET_PROVENANCE_KINDS).toEqual([
      "referenced",
      "from-provider",
      "generated-once",
      "committed-encrypted",
    ]);
  });

  test("collectSecretDeclarations extracts declarations by entity name", () => {
    const other = {
      lexicon: "test",
      entityType: "Test::Thing",
      [Symbol.for("chant.declarable")]: true,
    } as unknown as Declarable;
    const entities = new Map<string, Declarable>([
      ["thing", other],
      ["dbPassword", declareSecret({ name: "db-password", provenance: "generated-once" })],
    ]);
    const secrets = collectSecretDeclarations(entities);
    expect([...secrets.keys()]).toEqual(["dbPassword"]);
    expect(secrets.get("dbPassword")!.name).toBe("db-password");
  });

  test("partitionByLexicon excludes declarations from every partition", () => {
    const entities = new Map<string, Declarable>([
      [
        "thing",
        {
          lexicon: "test",
          entityType: "Test::Thing",
          [Symbol.for("chant.declarable")]: true,
        } as unknown as Declarable,
      ],
      ["secret", declareSecret({ name: "s", provenance: "referenced" })],
    ]);
    const partitions = partitionByLexicon(entities);
    expect([...partitions.keys()]).toEqual(["test"]);
    expect(partitions.get("test")!.has("secret")).toBe(false);
  });
});

describe("serializer neutrality (#1828 acceptance)", () => {
  test("a built project's outputs never contain a declaration, and no serializer receives one", async () => {
    const testDir = join(tmpdir(), `chant-secret-prov-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    try {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const modulePath = resolvePath(thisDir, "secret-provenance");
      await writeFile(
        join(testDir, "secrets.infra.ts"),
        `
        import { declareSecret } from ${JSON.stringify(modulePath)};
        export const dbPassword = declareSecret({ name: "db-password", provenance: "generated-once", keys: ["password"] });
        export const apiToken = declareSecret({ name: "api-token", provenance: "referenced", scope: "vault:prod" });
        export const providerFed = declareSecret({ name: "fountain-secrets", provenance: "from-provider", provider: { binding: "fountainInfisical" } });
        export const realResource = {
          lexicon: "test",
          entityType: "Test::Thing",
          [Symbol.for("chant.declarable")]: true,
        };
        `,
      );

      const seen: string[] = [];
      const testSerializer: Serializer = {
        name: "test",
        rulePrefix: "TEST",
        serialize: (entities) => {
          seen.push(...entities.keys());
          return JSON.stringify([...entities.keys()]);
        },
      };

      const result = await build(testDir, [testSerializer]);

      expect(result.errors).toEqual([]);
      // Discovery found all four exports.
      expect(result.entities.size).toBe(4);
      expect(isSecretDeclaration(result.entities.get("dbPassword")!)).toBe(true);
      const collected = collectSecretDeclarations(result.entities);
      expect([...collected.keys()].sort()).toEqual(["apiToken", "dbPassword", "providerFed"]);

      // No serializer received a declaration, no output mentions one, and the
      // declarations' pseudo-lexicon produced neither an output nor a warning.
      expect(seen).toEqual(["realResource"]);
      expect([...result.outputs.keys()]).toEqual(["test"]);
      for (const output of result.outputs.values()) {
        const text = typeof output === "string" ? output : JSON.stringify(output);
        expect(text).not.toContain("db-password");
        expect(text).not.toContain("api-token");
        expect(text).not.toContain("fountain-secrets");
      }
      expect(result.warnings.filter((w) => w.includes("No serializer"))).toEqual([]);
      // The manifest's stack list has no pseudo-stack for the declarations.
      expect(result.manifest.lexicons).toEqual(["test"]);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
