/**
 * The k8s effect-receipt materialization row (#2074, epic #1703) — the
 * declaration, the ConfigMap address derivation, what the serializer renders,
 * and the #1833 guards over the row.
 *
 * The shape mirrors lexicons/aws/src/effect-receipt-row.test.ts, which covers
 * the SSM row, so the two rows can be read against each other.
 */

import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import { loadAll } from "js-yaml";
import {
  EffectReceipt,
  receiptConfigMapName,
  receiptConfigMapRef,
  receiptNamespaceFrom,
  isEffectReceiptObject,
  parseReceiptComment,
  renderReceiptComment,
  EFFECT_RECEIPTS_COMMENT_MARKER,
  K8S_EFFECT_RECEIPT_ENTITY_TYPE,
  RECEIPT_DATA_KEY,
  RECEIPT_DEFAULT_NAMESPACE,
  RECEIPT_LABEL_KEY,
  RECEIPT_UNRESOLVED_VALUE_NOTE,
} from "./effect-receipt-row";
import { k8sSerializer } from "./serializer";
import {
  EXISTENCE_EXPECTATION,
  isEffectReceipt,
  receiptExpectation,
  EFFECT_RECEIPT_MARKER,
} from "@intentius/chant/effect-receipt";
import { receiptCheckInput } from "@intentius/chant/op/receipt-store";
import { coreReceiptChecks, RECEIPT_PLAIN_STORE_CHECK_ID } from "@intentius/chant/lint/receipt-checks";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { cor022ReceiptLeafRule } from "@intentius/chant/lint/rules/cor022-receipt-leaf";
import type { LintContext } from "@intentius/chant/lint/rule";

/** A minimal deploy-time reference, for the placeholder-value case. */
const someRef = { [INTRINSIC_MARKER]: true as const, toJSON: () => ({ ref: "other" }) };

const ownership = { stack: "demo", env: "dev" };

function serializeReceipts(
  receipts: Map<string, Declarable>,
  marker?: { stack: string; env?: string },
  config?: Record<string, unknown>,
): string {
  const out = k8sSerializer.serialize(new Map(), [], {
    ...(marker ? { ownership: marker } : {}),
    ...(config ? { config } : {}),
    receipts,
  });
  return typeof out === "string" ? out : out.primary;
}

function receiptRows(output: string) {
  return parseReceiptComment(output);
}

describe("EffectReceipt (k8s materialization row)", () => {
  it("declares under the k8s lexicon with the real resource kind, carrying the marker", () => {
    const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    expect(r.lexicon).toBe("k8s");
    expect(r.entityType).toBe(K8S_EFFECT_RECEIPT_ENTITY_TYPE);
    expect(r.entityType).toBe("K8s::Core::ConfigMap");
    expect(isEffectReceipt(r)).toBe(true);
  });

  it("is accepted by the effect() step's receiptCheckInput, expectation stamped when static", () => {
    const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "hash", inputs: { v: 1 } });
    const input = receiptCheckInput(r);
    expect(input.receipt.effect).toBe("db-seed");
    expect(input.expectation).toBe(receiptExpectation(r));
  });

  it("validates the effect as a name segment at declaration", () => {
    expect(() => EffectReceipt("bad", { effect: "db/seed", flavor: "existence" })).toThrow(/DNS-1123/);
    expect(() => EffectReceipt("bad", { effect: "DbSeed", flavor: "existence" })).toThrow(/DNS-1123/);
    expect(() => EffectReceipt("bad", { effect: "", flavor: "existence" })).toThrow(/non-empty/);
  });
});

describe("receiptConfigMapName", () => {
  it("derives chant-receipt.<stack>.<env>.<effect>", () => {
    expect(receiptConfigMapName("demo", "dev", "db-seed")).toBe("chant-receipt.demo.dev.db-seed");
  });

  it("refuses a segment that is not a DNS-1123 label, so the identity stays unambiguous", () => {
    expect(() => receiptConfigMapName("a.b", "dev", "seed")).toThrow(/stack/);
    expect(() => receiptConfigMapName("demo", "", "seed")).toThrow(/env/);
    expect(() => receiptConfigMapName("demo", "dev", "Seed")).toThrow(/effect/);
  });

  it("refuses a name over Kubernetes' 253-character ceiling", () => {
    expect(() => receiptConfigMapName("a".repeat(63), "b".repeat(63), "c".repeat(63))).not.toThrow();
    expect(() => receiptConfigMapName("a".repeat(64), "dev", "seed")).toThrow(/DNS-1123/);
  });

  it("addresses the receipt in the project's namespace, `default` when none is set", () => {
    expect(receiptConfigMapRef("demo", "dev", "db-seed")).toEqual({
      name: "chant-receipt.demo.dev.db-seed",
      namespace: RECEIPT_DEFAULT_NAMESPACE,
    });
    expect(receiptConfigMapRef("demo", "dev", "db-seed", "chant-system").namespace).toBe("chant-system");
    expect(receiptNamespaceFrom({ k8s: { receipts: { namespace: "chant-system" } } })).toBe("chant-system");
    expect(receiptNamespaceFrom(undefined)).toBe("default");
    expect(receiptNamespaceFrom({ k8s: {} })).toBe("default");
  });
});

describe("k8sSerializer receipt rows", () => {
  it("renders each receipt as a ConfigMap row at the derived address, expectation under data", () => {
    const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "hash", inputs: { v: 1 } });
    const rows = receiptRows(serializeReceipts(new Map([["seeded", seeded]]), ownership));
    expect(rows.seeded).toEqual({
      kind: "ConfigMap",
      namespace: "default",
      name: "chant-receipt.demo.dev.db-seed",
      data: { [RECEIPT_DATA_KEY]: receiptExpectation(seeded) },
    });
  });

  it("takes the namespace from k8s.receipts.namespace", () => {
    const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    const output = serializeReceipts(new Map([["seeded", seeded]]), ownership, {
      k8s: { receipts: { namespace: "chant-system" } },
    });
    expect(receiptRows(output).seeded.namespace).toBe("chant-system");
  });

  it("keeps the receipt out of the documents — the only thing an applier applies", () => {
    const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    const output = serializeReceipts(new Map([["seeded", seeded]]), ownership);
    const documents = loadAll(output).filter((d) => d && typeof d === "object");
    expect(documents).toEqual([]);
    expect(output).toContain(EFFECT_RECEIPTS_COMMENT_MARKER);
    expect(receiptRows(output).seeded).toBeDefined();
  });

  it("leaves a real manifest applyable with the comment appended", () => {
    const configMap = {
      [DECLARABLE_MARKER]: true as const,
      lexicon: "k8s",
      entityType: "K8s::Core::ConfigMap",
      props: { metadata: { name: "app-config" }, data: { a: "1" } },
    };
    const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    const out = k8sSerializer.serialize(
      new Map<string, Declarable>([["appConfig", configMap as unknown as Declarable]]),
      [],
      { ownership, receipts: new Map<string, Declarable>([["seeded", seeded]]) },
    );
    const output = typeof out === "string" ? out : out.primary;
    const documents = loadAll(output).filter((d): d is Record<string, unknown> => !!d && typeof d === "object");
    expect(documents).toHaveLength(1);
    expect((documents[0].metadata as { name: string }).name).toBe("app-config");
    expect(receiptRows(output).seeded.name).toBe("chant-receipt.demo.dev.db-seed");
  });

  it("renders the existence expectation for an existence receipt", () => {
    const r = EffectReceipt("booted", { effect: "bootstrap", flavor: "existence" });
    const rows = receiptRows(serializeReceipts(new Map([["booted", r]]), ownership));
    expect(rows.booted.data[RECEIPT_DATA_KEY]).toBe(EXISTENCE_EXPECTATION);
  });

  it("renders the placeholder note, never a placeholder digest, for reference inputs", () => {
    const r = EffectReceipt("wired", { effect: "wire-up", flavor: "hash", inputs: { target: someRef } });
    const rows = receiptRows(serializeReceipts(new Map([["wired", r]]), ownership));
    expect(rows.wired.data[RECEIPT_DATA_KEY]).toBe(RECEIPT_UNRESOLVED_VALUE_NOTE);
  });

  it("errors when no ownership marker resolves", () => {
    const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    expect(() => serializeReceipts(new Map([["seeded", r]]))).toThrow(/ownership/);
  });

  it("errors when ownership resolves no env — the segment is explicit, never guessed", () => {
    const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    expect(() => serializeReceipts(new Map([["seeded", r]]), { stack: "demo" })).toThrow(/env/);
  });

  it("emits no receipt block when the context carries no receipts", () => {
    const out = k8sSerializer.serialize(new Map(), [], { ownership });
    const output = typeof out === "string" ? out : out.primary;
    expect(output).not.toContain(EFFECT_RECEIPTS_COMMENT_MARKER);
    expect(parseReceiptComment(output)).toEqual({});
  });

  it("round-trips the block deterministically, and reads an output that has none as none", () => {
    const rows = {
      b: { kind: "ConfigMap" as const, namespace: "default", name: "chant-receipt.demo.dev.b", data: { expectation: "x" } },
      a: { kind: "ConfigMap" as const, namespace: "default", name: "chant-receipt.demo.dev.a", data: { expectation: "y" } },
    };
    const line = renderReceiptComment(rows);
    expect(line.indexOf('"a"')).toBeLessThan(line.indexOf('"b"'));
    expect(parseReceiptComment(`${line}\n`)).toEqual(rows);
    expect(parseReceiptComment("apiVersion: v1\nkind: Namespace\n")).toEqual({});
    expect(parseReceiptComment(`${EFFECT_RECEIPTS_COMMENT_MARKER}not json\n`)).toEqual({});
  });
});

describe("the receipt label", () => {
  it("recognizes a live receipt ConfigMap by its label alone", () => {
    expect(isEffectReceiptObject({ [RECEIPT_LABEL_KEY]: "db-seed" })).toBe(true);
    expect(isEffectReceiptObject({ [RECEIPT_LABEL_KEY]: "" })).toBe(false);
    expect(isEffectReceiptObject({ "app.kubernetes.io/managed-by": "chant" })).toBe(false);
    expect(isEffectReceiptObject(undefined)).toBe(false);
  });
});

describe("#1833's plain-store guard over the k8s row", () => {
  const check = coreReceiptChecks().find((c) => c.id === RECEIPT_PLAIN_STORE_CHECK_ID)!;

  function runCheck(entities: Map<string, Declarable>) {
    const ctx: PostSynthContext = {
      outputs: new Map(),
      entities,
      buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 0 },
    };
    return check.check(ctx);
  }

  it("passes the factory's row — a plain ConfigMap", () => {
    const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    expect(runCheck(new Map([["seeded", r]]))).toEqual([]);
  });

  it("fails a Secret-kind fixture, the same way it fails SSM SecureString", () => {
    const sneaky = {
      [DECLARABLE_MARKER]: true as const,
      [EFFECT_RECEIPT_MARKER]: true as const,
      lexicon: "k8s",
      entityType: "K8s::Core::Secret",
      name: "sneaky",
      effect: "db-seed",
      flavor: "existence" as const,
      inputs: {},
    };
    const diagnostics = runCheck(new Map([["sneaky", sneaky as unknown as Declarable]]));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].checkId).toBe(RECEIPT_PLAIN_STORE_CHECK_ID);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toMatch(/K8s::Core::Secret/);
  });
});

describe("#1833's leaf rule over a ConfigMap receipt", () => {
  /** The k8s source fixture: the row's own factory, referenced the way COR022
   * refuses. Recognition is by factory name, so the rule fires here exactly as
   * it fires on the aws SSM row. */
  function lintContext(code: string): LintContext {
    const sourceFile = ts.createSourceFile("infra.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return { sourceFile, entities: [], filePath: "infra.ts", lexicon: "k8s" };
  }

  it("fires when a ConfigMap derives a value from the receipt", () => {
    const diags = cor022ReceiptLeafRule.check(
      lintContext(`
        import { EffectReceipt, ConfigMap } from "@intentius/chant-lexicon-k8s";
        export const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
        export const app = new ConfigMap({ data: { seededBy: seeded.effect } });
      `),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR022");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain('"seeded" is an effect receipt');
  });

  it("passes when the receipt is only handed to the effect() step whole", () => {
    const diags = cor022ReceiptLeafRule.check(
      lintContext(`
        import { EffectReceipt } from "@intentius/chant-lexicon-k8s";
        export const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
        export const migrate = effect(seeded, [shell({ run: "./seed.sh" })]);
      `),
    );
    expect(diags).toEqual([]);
  });
});
