import { describe, it, expect } from "vitest";
import {
  planReceipts,
  mergeReceiptEntries,
  observedValueResolver,
  readReceiptValue,
  type ReceiptReading,
} from "./receipt-plan";
import { buildChangeSet, renderChangeSet, summarize, type ChangeSet } from "./change-set";
import {
  EffectReceipt,
  EXISTENCE_EXPECTATION,
  receiptExpectation,
  resolveReceiptExpectation,
  collectEffectReceipts,
  type EffectReceiptDeclaration,
} from "../effect-receipt";
import { AttrRef } from "../attrref";
import type { ResourceMetadata } from "../lexicon";
import type { ReceiptInputResolver } from "../effect-receipt";

const noRefs: ReceiptInputResolver = (_ref, path) => {
  throw new Error(`unexpected reference at ${path}`);
};

function receiptsOf(...decls: Array<[string, EffectReceiptDeclaration]>): Map<string, EffectReceiptDeclaration> {
  return new Map(decls);
}

describe("planReceipts", () => {
  it("absent receipt proposes the fire", () => {
    const r = EffectReceipt("dbMigrated", { effect: "db-migrate", flavor: "existence" });
    const readings = new Map<string, ReceiptReading>([
      ["dbMigrated", { observed: true, present: false, lexicon: "aws" }],
    ]);

    const entries = planReceipts(receiptsOf(["dbMigrated", r]), readings, noRefs);

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("effect");
    expect(entries[0].effect).toBe("db-migrate");
    expect(entries[0].effectReason).toBe("receipt-absent");
    expect(entries[0].evidence).toEqual({ declared: true, inSnapshot: false, live: false, observed: true });
  });

  it("stale hash proposes the fire, with both values in the detail", () => {
    const r = EffectReceipt("seeded", { effect: "seed", flavor: "hash", inputs: { rows: 10 } });
    const expected = receiptExpectation(r);
    const readings = new Map<string, ReceiptReading>([
      ["seeded", { observed: true, present: true, value: "sha256:0000", lexicon: "aws" }],
    ]);

    const entries = planReceipts(receiptsOf(["seeded", r]), readings, noRefs);

    expect(entries[0].action).toBe("effect");
    expect(entries[0].effectReason).toBe("receipt-stale");
    expect(entries[0].effectDetail).toContain("sha256:0000");
    expect(entries[0].effectDetail).toContain(expected);
  });

  it("matching receipt is a clean noop", () => {
    const r = EffectReceipt("seeded", { effect: "seed", flavor: "hash", inputs: { rows: 10 } });
    const readings = new Map<string, ReceiptReading>([
      ["seeded", { observed: true, present: true, value: receiptExpectation(r), lexicon: "aws" }],
    ]);

    const entries = planReceipts(receiptsOf(["seeded", r]), readings, noRefs);

    expect(entries[0].action).toBe("noop");
    expect(entries[0].effect).toBe("seed");
  });

  it("matching existence receipt is a clean noop", () => {
    const r = EffectReceipt("bootstrapped", { effect: "bootstrap", flavor: "existence" });
    const readings = new Map<string, ReceiptReading>([
      ["bootstrapped", { observed: true, present: true, value: EXISTENCE_EXPECTATION }],
    ]);

    expect(planReceipts(receiptsOf(["bootstrapped", r]), readings, noRefs)[0].action).toBe("noop");
  });

  it("a lexicon that could not look yields unobserved with its reason, never a clean row", () => {
    const r = EffectReceipt("dbMigrated", { effect: "db-migrate", flavor: "existence" });
    const readings = new Map<string, ReceiptReading>([
      ["dbMigrated", { observed: false, present: false, unobservedReason: "no-credentials", unobservedDetail: "no AWS credentials" }],
    ]);

    const entries = planReceipts(receiptsOf(["dbMigrated", r]), readings, noRefs);

    expect(entries[0].action).toBe("unobserved");
    expect(entries[0].unobservedReason).toBe("no-credentials");
    expect(entries[0].unobservedDetail).toBe("no AWS credentials");
  });

  it("a receipt no lexicon observes yields unobserved, loudly, never silently clean", () => {
    const r = EffectReceipt("dbMigrated", { effect: "db-migrate", flavor: "existence" });

    const entries = planReceipts(receiptsOf(["dbMigrated", r]), new Map(), noRefs);

    expect(entries[0].action).toBe("unobserved");
    expect(entries[0].unobservedReason).toBe("unsupported-kind");
    expect(entries[0].unobservedDetail).toContain("db-migrate");
    expect(entries[0].unobservedDetail).toContain("unknown, not clean");
  });

  it("a reference that cannot resolve at plan time proposes the fire with an unresolved-input note", () => {
    const parent = { entityType: "Test::Db" };
    const ref = new AttrRef(parent, "endpoint");
    ref._setLogicalName("db");
    const r = EffectReceipt("seeded", { effect: "seed", flavor: "hash", inputs: { endpoint: ref } });
    const readings = new Map<string, ReceiptReading>([
      ["seeded", { observed: true, present: true, value: "sha256:live" }],
    ]);

    // Resolver over observed values that do NOT include db.endpoint.
    const entries = planReceipts(receiptsOf(["seeded", r]), readings, observedValueResolver({}));

    expect(entries[0].action).toBe("effect");
    expect(entries[0].effectReason).toBe("unresolved-input");
    expect(entries[0].effectDetail).toContain("unresolved input");
    expect(entries[0].effectDetail).toContain("db.endpoint");
  });

  it("a reference input resolves against observed values and the comparison uses the resolved digest", () => {
    const parent = { entityType: "Test::Db" };
    const ref = new AttrRef(parent, "endpoint");
    ref._setLogicalName("db");
    const r = EffectReceipt("seeded", { effect: "seed", flavor: "hash", inputs: { endpoint: ref } });

    const observed: Record<string, ResourceMetadata> = {
      db: { type: "Test::Db", status: "ok", attributes: { endpoint: "db.example.internal:5432" } },
    };
    const resolver = observedValueResolver(observed);
    const expected = resolveReceiptExpectation(r, resolver);
    const readings = new Map<string, ReceiptReading>([
      ["seeded", { observed: true, present: true, value: expected }],
    ]);

    expect(planReceipts(receiptsOf(["seeded", r]), readings, resolver)[0].action).toBe("noop");
  });

  it("crash between effect and receipt write: the stale receipt re-proposes the fire on the next plan", () => {
    // Run 1 wrote the receipt for inputs { schema: 1 }. The effect for
    // { schema: 2 } ran, then the process died before the receipt write —
    // the live value still carries run 1's digest.
    const run1 = EffectReceipt("migrated", { effect: "migrate", flavor: "hash", inputs: { schema: 1 } });
    const run2 = EffectReceipt("migrated", { effect: "migrate", flavor: "hash", inputs: { schema: 2 } });
    const readings = new Map<string, ReceiptReading>([
      ["migrated", { observed: true, present: true, value: receiptExpectation(run1) }],
    ]);

    const entries = planReceipts(receiptsOf(["migrated", run2]), readings, noRefs);

    expect(entries[0].action).toBe("effect");
    expect(entries[0].effectReason).toBe("receipt-stale");

    // The first-run variant of the same crash: the effect ran, the write
    // never happened, the receipt is absent — the fire is proposed again.
    const absent = new Map<string, ReceiptReading>([["migrated", { observed: true, present: false }]]);
    expect(planReceipts(receiptsOf(["migrated", run2]), absent, noRefs)[0].effectReason).toBe("receipt-absent");
  });
});

describe("mergeReceiptEntries", () => {
  it("replaces the generic create proposed for an absent receipt with the effect row", () => {
    const r = EffectReceipt("dbMigrated", { effect: "db-migrate", flavor: "existence" });
    const receipts = receiptsOf(["dbMigrated", r]);

    // The generic classification knows nothing about receipts: declared and
    // confirmed absent classifies as create.
    const cs = buildChangeSet("prod", {
      declared: new Set(["dbMigrated", "bucket"]),
      observedNow: { bucket: { type: "Test::Bucket", status: "ok" } },
      observedThen: undefined,
    });
    expect(cs.entries.find((e) => e.name === "dbMigrated")?.action).toBe("create");

    const entries = planReceipts(receipts, new Map([["dbMigrated", { observed: true, present: false } as ReceiptReading]]), noRefs);
    mergeReceiptEntries(cs, receipts, entries);

    const row = cs.entries.filter((e) => e.name === "dbMigrated");
    expect(row).toHaveLength(1);
    expect(row[0].action).toBe("effect");
    expect(summarize(cs).create).toBe(0);
  });

  it("a live receipt is never a prune candidate: the generic delete is replaced", () => {
    const r = EffectReceipt("dbMigrated", { effect: "db-migrate", flavor: "existence" });
    const receipts = receiptsOf(["dbMigrated", r]);

    // Worst case for the write-exclusion: the receipt is live and owned but
    // missing from the declared axis the change set saw (exactly what
    // withholding it from the apply-bound set produces) — the generic
    // classification proposes delete, the prune candidacy a receipt must
    // never have.
    const cs = buildChangeSet("prod", {
      declared: new Set<string>(),
      observedNow: {
        dbMigrated: { type: "AWS::SSM::Parameter", status: "ok", ownership: "owned" },
      },
      observedThen: undefined,
    });
    expect(cs.entries.find((e) => e.name === "dbMigrated")?.action).toBe("delete");

    const entries = planReceipts(
      receipts,
      new Map([["dbMigrated", { observed: true, present: true, value: EXISTENCE_EXPECTATION } as ReceiptReading]]),
      noRefs,
    );
    mergeReceiptEntries(cs, receipts, entries);

    expect(cs.entries.filter((e) => e.action === "delete")).toHaveLength(0);
    expect(cs.entries.filter((e) => e.action === "adopt")).toHaveLength(0);
    expect(cs.entries.find((e) => e.name === "dbMigrated")?.action).toBe("noop");
  });
});

describe("renderChangeSet with effect entries", () => {
  it('renders "effect will fire: <effect>"', () => {
    const r = EffectReceipt("dbMigrated", { effect: "db-migrate", flavor: "existence" });
    const cs: ChangeSet = { env: "prod", entries: [] };
    mergeReceiptEntries(
      cs,
      receiptsOf(["dbMigrated", r]),
      planReceipts(receiptsOf(["dbMigrated", r]), new Map([["dbMigrated", { observed: true, present: false } as ReceiptReading]]), noRefs),
    );

    const rendered = renderChangeSet(cs);
    expect(rendered).toContain("effect will fire: db-migrate");
    expect(rendered).toContain("1 effect");
    expect(rendered).toContain("the generic apply never writes a receipt");
  });
});

describe("readReceiptValue", () => {
  it("reads value, falling back to the provider's Value casing", () => {
    expect(readReceiptValue({ value: "a" })).toBe("a");
    expect(readReceiptValue({ Value: "b" })).toBe("b");
    expect(readReceiptValue({ value: "a", Value: "b" })).toBe("a");
    expect(readReceiptValue(undefined)).toBeUndefined();
  });
});

describe("collectEffectReceipts over a mixed entity map", () => {
  it("finds only marker-carrying entities", () => {
    const r = EffectReceipt("dbMigrated", { effect: "db-migrate", flavor: "existence" });
    const entities = new Map<string, EffectReceiptDeclaration>([["dbMigrated", r]]);
    expect([...collectEffectReceipts(entities).keys()]).toEqual(["dbMigrated"]);
  });
});
