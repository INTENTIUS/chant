import { describe, it, expect } from "vitest";
import {
  EffectReceipt,
  receiptParameterName,
  AWS_EFFECT_RECEIPT_ENTITY_TYPE,
  EFFECT_RECEIPTS_METADATA_KEY,
  RECEIPT_UNRESOLVED_VALUE_NOTE,
} from "./effect-receipt-row";
import { awsSerializer } from "./serializer";
import { AWS_TAG_OWNERSHIP_KEYS } from "./ownership";
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

/** A minimal deploy-time reference, for the placeholder-value case. */
const someRef = { [INTRINSIC_MARKER]: true as const, toJSON: () => ({ Ref: "other" }) };

function serializeReceipts(
  receipts: Map<string, Declarable>,
  ownership?: { stack: string; env?: string },
): { Metadata?: Record<string, unknown>; Resources: Record<string, unknown> } {
  const out = awsSerializer.serialize(new Map(), [], {
    ...(ownership ? { ownership } : {}),
    receipts,
  });
  return JSON.parse(typeof out === "string" ? out : out.primary);
}

function metadataRows(template: { Metadata?: Record<string, unknown> }) {
  return template.Metadata?.[EFFECT_RECEIPTS_METADATA_KEY] as Record<
    string,
    { Type: string; Properties: Record<string, unknown> }
  >;
}

describe("EffectReceipt (aws materialization row)", () => {
  it("declares under the aws lexicon with the real resource kind, carrying the marker", () => {
    const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    expect(r.lexicon).toBe("aws");
    expect(r.entityType).toBe(AWS_EFFECT_RECEIPT_ENTITY_TYPE);
    expect(isEffectReceipt(r)).toBe(true);
    expect(r.props.Type).toBe("String");
  });

  it("is accepted by the effect() step's receiptCheckInput, expectation stamped when static", () => {
    const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "hash", inputs: { v: 1 } });
    const input = receiptCheckInput(r);
    expect(input.receipt.effect).toBe("db-seed");
    expect(input.expectation).toBe(receiptExpectation(r));
  });

  it("validates the effect as a path segment at declaration", () => {
    expect(() => EffectReceipt("bad", { effect: "a/b", flavor: "existence" })).toThrow(/path segment/);
    expect(() => EffectReceipt("bad", { effect: "", flavor: "existence" })).toThrow(/non-empty/);
  });
});

describe("receiptParameterName", () => {
  it("derives /chant-receipts/<stack>/<env>/<effect>", () => {
    expect(receiptParameterName("demo", "dev", "db-seed")).toBe("/chant-receipts/demo/dev/db-seed");
  });

  it("refuses a segment that would deepen the hierarchy", () => {
    expect(() => receiptParameterName("a/b", "dev", "seed")).toThrow(/stack/);
    expect(() => receiptParameterName("demo", "", "seed")).toThrow(/env/);
  });
});

describe("awsSerializer receipt rows", () => {
  const ownership = { stack: "demo", env: "dev" };

  it("renders each receipt as a plain-String SSM parameter row at the derived path, ownership-tagged", () => {
    const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "hash", inputs: { v: 1 } });
    const template = serializeReceipts(new Map([["seeded", seeded]]), ownership);
    const row = metadataRows(template).seeded;
    expect(row.Type).toBe("AWS::SSM::Parameter");
    expect(row.Properties.Name).toBe("/chant-receipts/demo/dev/db-seed");
    expect(row.Properties.Type).toBe("String");
    expect(row.Properties.Value).toBe(receiptExpectation(seeded));
    expect(row.Properties.Tags).toContainEqual({ Key: AWS_TAG_OWNERSHIP_KEYS.managedBy, Value: "chant" });
    expect(row.Properties.Tags).toContainEqual({ Key: AWS_TAG_OWNERSHIP_KEYS.stack, Value: "demo" });
    expect(row.Properties.Tags).toContainEqual({ Key: AWS_TAG_OWNERSHIP_KEYS.env, Value: "dev" });
  });

  it("keeps the receipt out of Resources — the section appliers write from", () => {
    const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    const template = serializeReceipts(new Map([["seeded", seeded]]), ownership);
    expect(Object.keys(template.Resources)).toHaveLength(0);
    expect(metadataRows(template).seeded).toBeDefined();
  });

  it("renders the existence expectation for an existence receipt", () => {
    const r = EffectReceipt("booted", { effect: "bootstrap", flavor: "existence" });
    const template = serializeReceipts(new Map([["booted", r]]), ownership);
    expect(metadataRows(template).booted.Properties.Value).toBe(EXISTENCE_EXPECTATION);
  });

  it("renders the placeholder note, never a placeholder digest, for reference inputs", () => {
    const r = EffectReceipt("wired", { effect: "wire-up", flavor: "hash", inputs: { target: someRef } });
    const template = serializeReceipts(new Map([["wired", r]]), ownership);
    expect(metadataRows(template).wired.Properties.Value).toBe(RECEIPT_UNRESOLVED_VALUE_NOTE);
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
    const out = awsSerializer.serialize(new Map(), [], { ownership });
    const template = JSON.parse(typeof out === "string" ? out : out.primary);
    expect(template.Metadata?.[EFFECT_RECEIPTS_METADATA_KEY]).toBeUndefined();
  });
});

describe("#1833's plain-store guard over the aws row", () => {
  const check = coreReceiptChecks().find((c) => c.id === RECEIPT_PLAIN_STORE_CHECK_ID)!;

  function runCheck(entities: Map<string, Declarable>) {
    const ctx: PostSynthContext = {
      outputs: new Map(),
      entities,
      buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 0 },
    };
    return check.check(ctx);
  }

  it("passes the factory's row — SSM plain String", () => {
    const r = EffectReceipt("seeded", { effect: "db-seed", flavor: "existence" });
    expect(runCheck(new Map([["seeded", r]]))).toEqual([]);
  });

  it("fails a SecureString fixture", () => {
    const secure = {
      [DECLARABLE_MARKER]: true as const,
      [EFFECT_RECEIPT_MARKER]: true as const,
      lexicon: "aws",
      entityType: "AWS::SSM::Parameter",
      name: "sneaky",
      effect: "db-seed",
      flavor: "existence" as const,
      inputs: {},
      props: { Type: "SecureString" },
    };
    const diagnostics = runCheck(new Map([["sneaky", secure as unknown as Declarable]]));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].checkId).toBe(RECEIPT_PLAIN_STORE_CHECK_ID);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toMatch(/SecureString/);
  });
});
