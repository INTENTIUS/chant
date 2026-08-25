/**
 * Committed SOPS ciphertext, end to end. What must hold: a
 * committed-encrypted `declareSecret()` resolves its file at `buildRoots()`,
 * the bytes leave the build BYTE-FOR-BYTE as a sidecar, the primary output
 * never carries them, and every way the claim can be false — missing file,
 * wrong name, no `sops` block, a value that is not `ENC[...]` — refuses with
 * the path in the message and nothing emitted.
 *
 * The fixture (`../testdata/sops/db-credentials.sops.yaml`) is a real
 * sops-shaped document: cleartext structure, `ENC[...]` values, an age
 * recipient block and a `mac`. Nothing in this suite decrypts anything —
 * there is no key, and no code path that could use one.
 */
import { describe, test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { build } from "@intentius/chant";
import { declareSecret, type CommittedEncryptedSecretDeclaration } from "@intentius/chant/secret-provenance";
import type { Declarable } from "@intentius/chant/declarable";
import {
  encryptedSecretBuildRoot,
  resolveEncryptedSecrets,
  validateEncryptedSecretDocument,
  committedEncryptedDeclarations,
} from "./encrypted-secret-file";
import { isEncryptedSecretFileEntity, ENCRYPTED_SECRET_FILE_TYPE } from "./entity";
import { k8sSerializer } from "../serializer";
import { k8sPlugin } from "../plugin";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "testdata", "sops");
const FIXTURE = "db-credentials.sops.yaml";
const FIXTURE_TEXT = readFileSync(join(fixtureRoot, FIXTURE), "utf-8");
/** Absolute path to core's factory — a temp project cannot resolve "@intentius/chant". */
const DECLARE_SECRET_MODULE = join(here, "..", "..", "..", "..", "packages", "core", "src", "secret-provenance");

function declaration(
  overrides: Partial<{ name: string; file: string }> = {},
): CommittedEncryptedSecretDeclaration {
  return declareSecret({
    name: overrides.name ?? "db-credentials",
    provenance: "committed-encrypted",
    file: overrides.file ?? FIXTURE,
    keys: ["POSTGRES_USER", "POSTGRES_PASSWORD"],
  });
}

function declarations(...decls: CommittedEncryptedSecretDeclaration[]) {
  return new Map(decls.map((d, i) => [`decl${i}`, d]));
}

describe("resolveEncryptedSecrets — the buildRoots read path", () => {
  test("reads the committed bytes and wraps them in one entity", () => {
    const entities = resolveEncryptedSecrets({
      projectRoot: fixtureRoot,
      declarations: declarations(declaration()),
    });

    expect([...entities.keys()]).toEqual(["sops:db-credentials"]);
    const entity = entities.get("sops:db-credentials")!;
    expect(isEncryptedSecretFileEntity(entity)).toBe(true);
    if (!isEncryptedSecretFileEntity(entity)) return;
    expect(entity.lexicon).toBe("k8s");
    expect(entity.entityType).toBe(ENCRYPTED_SECRET_FILE_TYPE);
    expect(entity.filename).toBe(FIXTURE);
    expect(entity.secretName).toBe("db-credentials");
    // The namespace is read from the file, not restated by the author — SOPS
    // encrypts values, not structure, so metadata is cleartext.
    expect(entity.namespace).toBe("apps");
    expect(entity.text).toBe(FIXTURE_TEXT);
  });

  test("a declaration in a subdirectory keeps the basename as the sidecar name", () => {
    const entities = resolveEncryptedSecrets({
      projectRoot: join(fixtureRoot, ".."),
      declarations: declarations(declaration({ file: `sops/${FIXTURE}` })),
    });
    const entity = [...entities.values()][0];
    expect(isEncryptedSecretFileEntity(entity) && entity.filename).toBe(FIXTURE);
  });

  test("no committed-encrypted declarations contributes nothing", async () => {
    const contribution = await encryptedSecretBuildRoot({ projectRoot: fixtureRoot, config: {} });
    expect(contribution.entities.size).toBe(0);
  });

  test("the plugin hook resolves declarations from ctx.entities", async () => {
    const contribution = await k8sPlugin.buildRoots!({
      projectRoot: fixtureRoot,
      config: {},
      entities: new Map<string, Declarable>([["dbCredentials", declaration()]]),
    });
    expect([...contribution.entities.keys()]).toEqual(["sops:db-credentials"]);
  });

  test("committedEncryptedDeclarations ignores the other three kinds", () => {
    const entities = new Map<string, Declarable>([
      ["a", declareSecret({ name: "a", provenance: "referenced" })],
      ["b", declareSecret({ name: "b", provenance: "generated-once", keys: ["k"] })],
      ["c", declaration()],
    ]);
    expect([...committedEncryptedDeclarations(entities).keys()]).toEqual(["c"]);
  });

  test("a missing file refuses, naming the resolved path", () => {
    expect(() =>
      resolveEncryptedSecrets({
        projectRoot: fixtureRoot,
        declarations: declarations(declaration({ name: "gone", file: "nowhere.sops.yaml" })),
      }),
    ).toThrow(/not readable at .*nowhere\.sops\.yaml/);
  });

  test("two declarations whose paths share a basename refuse rather than overwrite", async () => {
    const dir = join(tmpdir(), `chant-sops-collide-${Date.now()}-${Math.random()}`);
    await mkdir(join(dir, "a"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
    try {
      await writeFile(join(dir, "a", "creds.sops.yaml"), FIXTURE_TEXT);
      await writeFile(
        join(dir, "b", "creds.sops.yaml"),
        FIXTURE_TEXT.replace("name: db-credentials", "name: other-credentials"),
      );
      expect(() =>
        resolveEncryptedSecrets({
          projectRoot: dir,
          declarations: declarations(
            declaration({ file: "a/creds.sops.yaml" }),
            declaration({ name: "other-credentials", file: "b/creds.sops.yaml" }),
          ),
        }),
      ).toThrow(/collides/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("validateEncryptedSecretDocument", () => {
  const declared = { name: "db-credentials", file: FIXTURE };

  test("the fixture is clean, and its key names (never values) are read back", () => {
    const { problems, document } = validateEncryptedSecretDocument(FIXTURE_TEXT, declared);
    expect(problems).toEqual([]);
    expect(document!.name).toBe("db-credentials");
    expect(document!.namespace).toBe("apps");
    expect(document!.keys.sort()).toEqual(["POSTGRES_PASSWORD", "POSTGRES_USER"]);
  });

  test("a metadata.name other than the declared one is a problem", () => {
    const text = FIXTURE_TEXT.replace("name: db-credentials", "name: other-credentials");
    const { problems } = validateEncryptedSecretDocument(text, declared);
    expect(problems.join("\n")).toMatch(/metadata\.name "other-credentials"/);
  });

  test("a document that is not a v1 Secret is a problem", () => {
    const text = FIXTURE_TEXT.replace("kind: Secret", "kind: ConfigMap");
    const { problems } = validateEncryptedSecretDocument(text, declared);
    expect(problems.join("\n")).toMatch(/not a v1 Secret/);
  });

  test("a missing sops block is a problem — the file was never encrypted", () => {
    const text = FIXTURE_TEXT.slice(0, FIXTURE_TEXT.indexOf("sops:"));
    const { problems } = validateEncryptedSecretDocument(text, declared);
    expect(problems.join("\n")).toMatch(/no top-level `sops` block/);
  });

  test("a plaintext data value is a problem, reported by KEY name only", () => {
    const text = FIXTURE_TEXT.replace(
      /POSTGRES_PASSWORD: ENC\[[^\]]*\]/,
      "POSTGRES_PASSWORD: hunter2",
    );
    const { problems } = validateEncryptedSecretDocument(text, declared);
    const message = problems.join("\n");
    expect(message).toMatch(/stringData\."POSTGRES_PASSWORD" is not encrypted/);
    // The constitutional line: a value is tested, never echoed.
    expect(message).not.toContain("hunter2");
  });

  test("multi-document files are refused in v1", () => {
    const { problems } = validateEncryptedSecretDocument(`${FIXTURE_TEXT}\n---\n${FIXTURE_TEXT}`, declared);
    expect(problems.join("\n")).toMatch(/contains 2 YAML documents/);
  });

  test("unparseable YAML is refused, not thrown through", () => {
    const { problems } = validateEncryptedSecretDocument("a:\n  - b\n c: [", declared);
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/not valid YAML/);
  });

  test("every problem is reported at once, not one per build", () => {
    const text = FIXTURE_TEXT.replace("name: db-credentials", "name: wrong").replace(
      /POSTGRES_USER: ENC\[[^\]]*\]/,
      "POSTGRES_USER: postgres",
    );
    const { problems } = validateEncryptedSecretDocument(text, declared);
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  test("resolution refuses on any problem, emitting nothing", () => {
    const dir = join(tmpdir(), `chant-sops-bad-${Date.now()}-${Math.random()}`);
    return (async () => {
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(
          join(dir, FIXTURE),
          FIXTURE_TEXT.replace(/POSTGRES_USER: ENC\[[^\]]*\]/, "POSTGRES_USER: postgres"),
        );
        expect(() =>
          resolveEncryptedSecrets({ projectRoot: dir, declarations: declarations(declaration()) }),
        ).toThrow(/does not resolve[\s\S]*is not encrypted/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })();
  });
});

describe("sidecar emission", () => {
  const workload: Declarable = {
    lexicon: "k8s",
    entityType: "K8s::Apps::Deployment",
    kind: "resource",
    props: {
      metadata: { name: "api", namespace: "apps" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "api", image: "api:1.0", envFrom: [{ secretRef: { name: "db-credentials" } }] },
            ],
          },
        },
      },
    },
    [Symbol.for("chant.declarable")]: true,
  } as unknown as Declarable;

  function serializeWithCiphertext() {
    const entities = new Map<string, Declarable>([["api", workload]]);
    for (const [name, entity] of resolveEncryptedSecrets({
      projectRoot: fixtureRoot,
      declarations: declarations(declaration()),
    })) {
      entities.set(name, entity);
    }
    return k8sSerializer.serialize(entities);
  }

  test("the ciphertext leaves as a sidecar file, byte for byte", () => {
    const result = serializeWithCiphertext();
    expect(typeof result).toBe("object");
    if (typeof result === "string") return;
    expect(Object.keys(result.files ?? {})).toEqual([FIXTURE]);
    expect(result.files![FIXTURE]).toBe(FIXTURE_TEXT);
  });

  test("the primary output carries no ciphertext and no Secret document", () => {
    const result = serializeWithCiphertext();
    const primary = typeof result === "string" ? result : result.primary;
    expect(primary).toContain("kind: Deployment");
    expect(primary).not.toContain("ENC[");
    expect(primary).not.toContain("kind: Secret");
    expect(primary).not.toContain("sops");
  });

  test("a build with no ciphertext still returns a bare string — the common case is unchanged", () => {
    const result = k8sSerializer.serialize(new Map<string, Declarable>([["api", workload]]));
    expect(typeof result).toBe("string");
  });

  test("the whole path through build(): declaration in, sidecar out", async () => {
    const dir = join(tmpdir(), `chant-sops-build-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, FIXTURE), FIXTURE_TEXT);
      await writeFile(
        join(dir, "secrets.infra.ts"),
        `import { declareSecret } from ${JSON.stringify(DECLARE_SECRET_MODULE)};
export const dbCredentials = declareSecret({
  name: "db-credentials",
  provenance: "committed-encrypted",
  file: ${JSON.stringify(FIXTURE)},
  keys: ["POSTGRES_USER", "POSTGRES_PASSWORD"],
});
`,
      );

      const result = await build(dir, [k8sSerializer], undefined, {
        buildRoots: [(ctx) => k8sPlugin.buildRoots!({ projectRoot: dir, config: {}, entities: ctx.entities })],
      });

      expect(result.errors).toEqual([]);
      const output = result.outputs.get("k8s")!;
      expect(typeof output).toBe("object");
      if (typeof output === "string") return;
      expect(output.files![FIXTURE]).toBe(FIXTURE_TEXT);
      expect(output.primary).not.toContain("ENC[");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a broken declaration fails the build with a message, not a stack trace", async () => {
    const dir = join(tmpdir(), `chant-sops-build-bad-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(
        join(dir, "secrets.infra.ts"),
        `import { declareSecret } from ${JSON.stringify(DECLARE_SECRET_MODULE)};
export const dbCredentials = declareSecret({
  name: "db-credentials",
  provenance: "committed-encrypted",
  file: "secrets/never-committed.sops.yaml",
});
`,
      );

      const result = await build(dir, [k8sSerializer], undefined, {
        buildRoots: [(ctx) => k8sPlugin.buildRoots!({ projectRoot: dir, config: {}, entities: ctx.entities })],
      });

      expect(result.errors.length).toBe(1);
      expect(result.errors[0].message).toContain("never-committed.sops.yaml");
      expect(result.errors[0].message).toContain("not readable");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
