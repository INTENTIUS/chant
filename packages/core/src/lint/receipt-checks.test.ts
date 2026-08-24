import { describe, test, expect } from "vitest";
import { coreReceiptChecks, RECEIPT_PLAIN_STORE_CHECK_ID } from "./receipt-checks";
import { runPostSynthChecks } from "./post-synth";
import { EffectReceipt, EFFECT_RECEIPT_MARKER } from "../effect-receipt";
import { DECLARABLE_MARKER, type Declarable } from "../declarable";

/** A lexicon-materialized receipt row: its own entityType, the receipt marker. */
function materializedReceipt(opts: {
  lexicon: string;
  entityType: string;
  props?: Record<string, unknown>;
}): Declarable {
  return {
    [DECLARABLE_MARKER]: true,
    [EFFECT_RECEIPT_MARKER]: true,
    lexicon: opts.lexicon,
    entityType: opts.entityType,
    ...(opts.props ? { props: opts.props } : {}),
  } as unknown as Declarable;
}

function run(entities: Map<string, Declarable>) {
  return runPostSynthChecks(coreReceiptChecks(), {
    outputs: new Map(),
    entities,
    warnings: [],
    errors: [],
    sourceFileCount: 1,
  });
}

describe("COR023: receipt materializes into a plain store (#1833)", () => {
  test("check id", () => {
    expect(RECEIPT_PLAIN_STORE_CHECK_ID).toBe("COR023");
    expect(coreReceiptChecks().map((c) => c.id)).toContain("COR023");
  });

  test("fires when a receipt is materialized into a Secret kind", () => {
    const entities = new Map<string, Declarable>([
      ["seededReceipt", materializedReceipt({ lexicon: "k8s", entityType: "K8s::Core::Secret" })],
    ]);
    const diags = run(entities);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("COR023");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("seededReceipt");
    expect(diags[0].message).toContain("K8s::Core::Secret");
    expect(diags[0].message).toContain("plain store");
  });

  test("fires when a plain kind selects a secret-capable variant (SSM SecureString)", () => {
    const entities = new Map<string, Declarable>([
      [
        "migratedReceipt",
        materializedReceipt({
          lexicon: "aws",
          entityType: "AWS::SSM::Parameter",
          props: { Name: "/receipts/migrated", Type: "SecureString" },
        }),
      ],
    ]);
    const diags = run(entities);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('Type: "SecureString"');
    expect(diags[0].entity).toBe("migratedReceipt");
  });

  test("passes: a receipt materialized into a plain store", () => {
    const entities = new Map<string, Declarable>([
      [
        "migratedReceipt",
        materializedReceipt({
          lexicon: "aws",
          entityType: "AWS::SSM::Parameter",
          props: { Name: "/receipts/migrated", Type: "String" },
        }),
      ],
    ]);
    expect(run(entities)).toHaveLength(0);
  });

  test("passes: the core Chant::EffectReceipt declaration itself", () => {
    const receipt = EffectReceipt("seeded", {
      effect: "db-seed",
      flavor: "hash",
      inputs: { schema: "v3" },
    });
    const entities = new Map<string, Declarable>([["seeded", receipt]]);
    expect(run(entities)).toHaveLength(0);
  });

  test("passes: a Secret-kind entity that is NOT a receipt is not this check's concern", () => {
    const secret: Declarable = {
      [DECLARABLE_MARKER]: true,
      lexicon: "k8s",
      entityType: "K8s::Core::Secret",
    } as unknown as Declarable;
    const entities = new Map<string, Declarable>([["dbSecret", secret]]);
    expect(run(entities)).toHaveLength(0);
  });
});
