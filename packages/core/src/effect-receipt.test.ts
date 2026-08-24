import { describe, test, expect } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createHash } from "node:crypto";
import {
  EffectReceipt,
  isEffectReceipt,
  collectEffectReceipts,
  canonicalJson,
  receiptExpectation,
  resolveReceiptExpectation,
  referenceInputPaths,
  EFFECT_RECEIPT_MARKER,
  EFFECT_RECEIPT_ENTITY_TYPE,
  EFFECT_RECEIPT_FLAVORS,
  EXISTENCE_EXPECTATION,
  type EffectReceiptDeclaration,
} from "./effect-receipt";
import { isDeclarable, DECLARABLE_MARKER, type Declarable } from "./declarable";
import { INTRINSIC_MARKER, type Intrinsic } from "./intrinsic";
import { AttrRef } from "./attrref";
import { build, partitionByLexicon } from "./build";
import type { Serializer } from "./serializer";
import { encodeEntitySet, decodeEntitySet, type EntitySetWire } from "./discovery/entity-wire";
import { resolveAttrRefs } from "./discovery/resolve";
import type { LintContext } from "./lint/rule";
import {
  evl001NonLiteralExpressionRule,
  evl002ControlFlowResourceRule,
  evl003DynamicPropertyAccessRule,
  evl004SpreadNonConstRule,
  evl005ResourceBlockBodyRule,
  evl007InvalidSiblingsRule,
  evl009CompositeNoConstantRule,
  evl010CompositeNoTransformRule,
} from "./lint/rules";

function sha256(canonical: string): string {
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function fakeIntrinsic(json: unknown): Intrinsic {
  return {
    [INTRINSIC_MARKER]: true,
    toJSON: () => json,
  };
}

describe("EffectReceipt — factory", () => {
  test("existence flavor carries name, effect, flavor, inputs", () => {
    const receipt = EffectReceipt("migrated", { effect: "db-migrate", flavor: "existence" });
    expect(receipt.name).toBe("migrated");
    expect(receipt.effect).toBe("db-migrate");
    expect(receipt.flavor).toBe("existence");
    expect(receipt.inputs).toEqual({});
    expect(receipt.lexicon).toBe("chant");
    expect(receipt.entityType).toBe(EFFECT_RECEIPT_ENTITY_TYPE);
    expect(EFFECT_RECEIPT_FLAVORS).toEqual(["existence", "hash"]);
  });

  test("hash flavor records static inputs verbatim, frozen", () => {
    const receipt = EffectReceipt("seeded", {
      effect: "db-seed",
      flavor: "hash",
      inputs: { schema: "v42", tables: ["users", "orders"] },
    });
    expect(receipt.flavor).toBe("hash");
    expect(receipt.inputs).toEqual({ schema: "v42", tables: ["users", "orders"] });
    expect(Object.isFrozen(receipt.inputs)).toBe(true);
    expect(Object.isFrozen((receipt.inputs as { tables: string[] }).tables)).toBe(true);
  });

  test("declared fields are immutable; the object stays extensible for discovery metadata", () => {
    const receipt = EffectReceipt("r", { effect: "e", flavor: "existence" });
    expect(() => {
      (receipt as { effect: string }).effect = "mutated";
    }).toThrow();
    // Discovery stamps symbol-keyed metadata onto entities — that must work.
    const stamp = Symbol.for("chant.test.stamp");
    (receipt as unknown as Record<symbol, unknown>)[stamp] = "ok";
    expect((receipt as unknown as Record<symbol, unknown>)[stamp]).toBe("ok");
  });

  test("intrinsic inputs are left live (not frozen) so discovery can assign logical names", () => {
    const parent = { name: "bucket" };
    const ref = new AttrRef(parent, "arn");
    EffectReceipt("r", { effect: "e", flavor: "hash", inputs: { target: ref } });
    expect(() => ref._setLogicalName("Bucket")).not.toThrow();
    expect(ref.getLogicalName()).toBe("Bucket");
  });

  test("rejects an empty name, an empty effect, an unknown flavor, and non-object inputs", () => {
    expect(() => EffectReceipt("", { effect: "e", flavor: "existence" })).toThrow(/name/);
    expect(() => EffectReceipt("r", { effect: "", flavor: "existence" })).toThrow(/effect/);
    expect(() =>
      // @ts-expect-error — the flavor union is closed
      EffectReceipt("r", { effect: "e", flavor: "digest" }),
    ).toThrow(/unknown flavor/);
    expect(() =>
      // @ts-expect-error — inputs must be a plain object
      EffectReceipt("r", { effect: "e", flavor: "hash", inputs: ["a"] }),
    ).toThrow(/inputs/);
  });

  test("a receipt is a Declarable and an EffectReceipt; the guard rejects unmarked shapes", () => {
    const receipt = EffectReceipt("r", { effect: "e", flavor: "existence" });
    expect(isDeclarable(receipt)).toBe(true);
    expect(isEffectReceipt(receipt)).toBe(true);
    expect((receipt as unknown as Record<symbol, unknown>)[EFFECT_RECEIPT_MARKER]).toBe(true);
    expect(isEffectReceipt({ name: "r", effect: "e", flavor: "existence" })).toBe(false);
  });

  test("the marker recognizes a lexicon-materialized resource core knows nothing about", () => {
    // A lexicon row (#1835) stamps the SAME Symbol.for marker on its own
    // resource — core's guards must recognize it without aws knowledge.
    const materialized = {
      [DECLARABLE_MARKER]: true,
      [EFFECT_RECEIPT_MARKER]: true,
      lexicon: "aws",
      entityType: "AWS::SSM::Parameter",
      kind: "resource",
      props: { Name: "/chant-receipts/app/prod/db-migrate", Type: "String" },
    } as unknown as Declarable;
    expect(isEffectReceipt(materialized)).toBe(true);
  });
});

describe("canonicalJson — JCS-style", () => {
  test("sorts object keys and strips whitespace, at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("number forms canonicalize to one encoding", () => {
    expect(canonicalJson({ n: 1.0 })).toBe('{"n":1}');
    expect(canonicalJson({ n: 1e2 })).toBe('{"n":100}');
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
    expect(canonicalJson({ n: 1e21 })).toBe('{"n":1e+21}');
  });

  test("honors toJSON, which is what keeps references in placeholder form", () => {
    const placeholder = fakeIntrinsic({ __attrRef: { entity: "Bucket", attribute: "arn" } });
    expect(canonicalJson({ target: placeholder })).toBe(
      '{"target":{"__attrRef":{"attribute":"arn","entity":"Bucket"}}}',
    );
  });

  test("drops undefined object properties; arrays keep order and encode holes as null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
  });

  test("throws on non-representable values instead of silently coercing", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ b: 10n })).toThrow(/bigint/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/);
    expect(() => canonicalJson(undefined)).toThrow(/not representable/);
  });
});

describe("receiptExpectation — static inputs hash at synthesis", () => {
  test("existence flavor is the marker constant, inputs or not", () => {
    expect(receiptExpectation(EffectReceipt("a", { effect: "e", flavor: "existence" }))).toBe(
      EXISTENCE_EXPECTATION,
    );
    expect(
      receiptExpectation(EffectReceipt("b", { effect: "e", flavor: "existence", inputs: { v: 1 } })),
    ).toBe(EXISTENCE_EXPECTATION);
  });

  test("hash flavor digests canonical {effect, inputs} — deterministic across key order and number forms", () => {
    const one = EffectReceipt("r1", {
      effect: "db-migrate",
      flavor: "hash",
      inputs: { schema: "v42", batch: 100 },
    });
    const two = EffectReceipt("r2", {
      effect: "db-migrate",
      flavor: "hash",
      inputs: { batch: 1e2, schema: "v42" },
    });
    expect(receiptExpectation(one)).toBe(receiptExpectation(two));
    expect(receiptExpectation(one)).toBe(
      sha256(canonicalJson({ effect: "db-migrate", inputs: { batch: 100, schema: "v42" } })),
    );
    expect(receiptExpectation(one)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("the effect name is bound into the digest — same inputs, different effect, different expectation", () => {
    const a = EffectReceipt("a", { effect: "db-migrate", flavor: "hash", inputs: { v: 1 } });
    const b = EffectReceipt("b", { effect: "db-seed", flavor: "hash", inputs: { v: 1 } });
    expect(receiptExpectation(a)).not.toBe(receiptExpectation(b));
  });

  test("a hash receipt with reference inputs refuses at synthesis — references never resolve here", () => {
    const receipt = EffectReceipt("r", {
      effect: "e",
      flavor: "hash",
      inputs: { static: "s", nested: { target: fakeIntrinsic("live") } },
    });
    expect(referenceInputPaths(receipt)).toEqual(["inputs.nested.target"]);
    expect(() => receiptExpectation(receipt)).toThrow(/inputs\.nested\.target/);
    expect(() => receiptExpectation(receipt)).toThrow(/never at synthesis/);
  });
});

describe("resolveReceiptExpectation — the plan/effect-step side of the split", () => {
  test("placeholder and resolved forms differ, and resolution is deterministic", () => {
    const placeholder = fakeIntrinsic({ __attrRef: { entity: "Db", attribute: "endpoint" } });
    const receipt = EffectReceipt("r", {
      effect: "db-migrate",
      flavor: "hash",
      inputs: { endpoint: placeholder, schema: "v42" },
    });

    const resolver = (ref: Intrinsic): unknown => {
      expect(ref).toBe(placeholder);
      return "db.prod.internal:5432";
    };
    const resolvedOnce = resolveReceiptExpectation(receipt, resolver);
    const resolvedTwice = resolveReceiptExpectation(receipt, resolver);
    expect(resolvedOnce).toBe(resolvedTwice);

    // The digest is over RESOLVED inputs — not over the placeholder envelope.
    const placeholderDigest = sha256(
      canonicalJson({ effect: "db-migrate", inputs: receipt.inputs }),
    );
    const expectedDigest = sha256(
      canonicalJson({
        effect: "db-migrate",
        inputs: { endpoint: "db.prod.internal:5432", schema: "v42" },
      }),
    );
    expect(resolvedOnce).toBe(expectedDigest);
    expect(resolvedOnce).not.toBe(placeholderDigest);
  });

  test("a fully static hash receipt resolves to exactly its synthesis-time expectation", () => {
    const receipt = EffectReceipt("r", { effect: "e", flavor: "hash", inputs: { v: 1 } });
    const neverCalled = (): unknown => {
      throw new Error("resolver must not be called for static inputs");
    };
    expect(resolveReceiptExpectation(receipt, neverCalled)).toBe(receiptExpectation(receipt));
  });

  test("existence flavor resolves to the marker constant without consulting the resolver", () => {
    const receipt = EffectReceipt("r", {
      effect: "e",
      flavor: "existence",
      inputs: { ref: fakeIntrinsic("x") },
    });
    const neverCalled = (): unknown => {
      throw new Error("resolver must not be called for an existence receipt");
    };
    expect(resolveReceiptExpectation(receipt, neverCalled)).toBe(EXISTENCE_EXPECTATION);
  });

  test("resolver answers are validated: undefined and reference-for-reference throw with the path", () => {
    const receipt = EffectReceipt("r", {
      effect: "e",
      flavor: "hash",
      inputs: { a: fakeIntrinsic("x") },
    });
    expect(() => resolveReceiptExpectation(receipt, () => undefined)).toThrow(/inputs\.a/);
    expect(() => resolveReceiptExpectation(receipt, () => fakeIntrinsic("y"))).toThrow(
      /another reference/,
    );
  });

  test("references resolve at any depth, including inside arrays", () => {
    const receipt = EffectReceipt("r", {
      effect: "e",
      flavor: "hash",
      inputs: { list: [1, fakeIntrinsic("x"), { deep: fakeIntrinsic("y") }] },
    });
    expect(referenceInputPaths(receipt)).toEqual(["inputs.list[1]", "inputs.list[2].deep"]);
    const byPath: Record<string, unknown> = {
      "inputs.list[1]": "one",
      "inputs.list[2].deep": "two",
    };
    const digest = resolveReceiptExpectation(receipt, (_ref, path) => byPath[path]);
    expect(digest).toBe(
      sha256(canonicalJson({ effect: "e", inputs: { list: [1, "one", { deep: "two" }] } })),
    );
  });
});

describe("marker survives the entity-wire codec (#1828's sandbox-brand mold)", () => {
  test("a receipt round-trips its marker and declared fields through pure JSON", () => {
    const receipt = EffectReceipt("migrated", {
      effect: "db-migrate",
      flavor: "hash",
      inputs: { schema: "v42" },
    });
    const entities = new Map<string, Declarable>([["migrated", receipt]]);
    resolveAttrRefs(entities);

    const wire = encodeEntitySet(entities);
    expect(() => JSON.parse(JSON.stringify(wire))).not.toThrow();

    const decoded = decodeEntitySet(JSON.parse(JSON.stringify(wire)) as EntitySetWire);
    const decodedReceipt = decoded.get("migrated");
    expect(decodedReceipt).toBeDefined();
    expect(isEffectReceipt(decodedReceipt)).toBe(true);
    const r = decodedReceipt as unknown as EffectReceiptShape;
    expect(r.name).toBe("migrated");
    expect(r.effect).toBe("db-migrate");
    expect(r.flavor).toBe("hash");
    expect(r.inputs).toEqual({ schema: "v42" });
    // The decoded receipt still hashes to the same expectation.
    expect(receiptExpectation(decodedReceipt as EffectReceiptDeclaration)).toBe(receiptExpectation(receipt));
  });

  interface EffectReceiptShape {
    name: string;
    effect: string;
    flavor: string;
    inputs: unknown;
  }
});

describe("EVL-clean — a project declaring receipts passes lint", () => {
  const evlRules = [
    evl001NonLiteralExpressionRule,
    evl002ControlFlowResourceRule,
    evl003DynamicPropertyAccessRule,
    evl004SpreadNonConstRule,
    evl005ResourceBlockBodyRule,
    evl007InvalidSiblingsRule,
    evl009CompositeNoConstantRule,
    evl010CompositeNoTransformRule,
  ];

  test("both flavors, static and referenced inputs, produce zero EVL diagnostics", () => {
    const source = `
      import { EffectReceipt } from "@intentius/chant";
      import { dbCluster } from "./db.infra";

      export const migrated = EffectReceipt("migrated", {
        effect: "db-migrate",
        flavor: "hash",
        inputs: { schema: "v42", endpoint: dbCluster.endpoint },
      });

      export const seeded = EffectReceipt("seeded", {
        effect: "db-seed",
        flavor: "existence",
      });
    `;
    const sourceFile = ts.createSourceFile("receipts.infra.ts", source, ts.ScriptTarget.Latest, true);
    const context: LintContext = {
      sourceFile,
      entities: [],
      filePath: "receipts.infra.ts",
      lexicon: undefined,
    };
    for (const rule of evlRules) {
      expect(rule.check(context)).toEqual([]);
    }
  });
});

describe("receipts and discovery (the marker identifies, it does not exclude)", () => {
  test("collectEffectReceipts finds receipts in a built project; partitions keep them", async () => {
    const testDir = join(tmpdir(), `chant-effect-receipt-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    try {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const modulePath = resolvePath(thisDir, "effect-receipt");
      await writeFile(
        join(testDir, "receipts.infra.ts"),
        `
        import { EffectReceipt } from ${JSON.stringify(modulePath)};
        export const migrated = EffectReceipt("migrated", {
          effect: "db-migrate",
          flavor: "hash",
          inputs: { schema: "v42" },
        });
        export const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
        export const realResource = {
          lexicon: "test",
          entityType: "Test::Thing",
          [Symbol.for("chant.declarable")]: true,
        };
        `,
      );

      const testSerializer: Serializer = {
        name: "test",
        rulePrefix: "TEST",
        serialize: (entities) => JSON.stringify([...entities.keys()]),
      };

      const result = await build(testDir, [testSerializer]);
      expect(result.errors).toEqual([]);
      expect(result.entities.size).toBe(3);

      const receipts = collectEffectReceipts(result.entities);
      expect([...receipts.keys()].sort()).toEqual(["migrated", "seeded"]);
      expect(receipts.get("migrated")!.effect).toBe("db-migrate");
      expect(receiptExpectation(receipts.get("migrated")!)).toMatch(/^sha256:/);

      // Unlike secret declarations (#1828), receipts are NOT excluded from
      // partitioning — they become real resources via a lexicon row (#1835),
      // so the partition for their lexicon keeps them.
      const partitions = partitionByLexicon(result.entities);
      expect(partitions.get("chant")).toBeDefined();
      expect([...partitions.get("chant")!.keys()].sort()).toEqual(["migrated", "seeded"]);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
