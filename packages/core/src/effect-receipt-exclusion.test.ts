/**
 * #1832 — the generic apply path provably never writes an effect receipt.
 *
 * Appliers consume the serialized build outputs, so the write-exclusion lives
 * at serializer-input assembly (build step 7): entities carrying
 * EFFECT_RECEIPT_MARKER are withheld from the apply-bound entity map and ride
 * `SerializeContext.receipts` instead. These tests drive a real build over a
 * fixture containing a receipt, spy on the serializer (the applier-input
 * boundary), and drive the serialized output through a mock applier to show
 * the receipt reaches neither its desired set nor its prune candidates.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { build } from "./build";
import { splitReceiptEntities, EffectReceipt } from "./effect-receipt";
import type { Serializer, SerializeContext } from "./serializer";
import type { Declarable } from "./declarable";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RECEIPT_FIXTURE = `
export const bucket = {
  lexicon: "test",
  entityType: "Test::Bucket",
  props: { name: "assets" },
  [Symbol.for("chant.declarable")]: true,
};

// The shape a lexicon-materialized receipt row has (#1835): its own lexicon
// and entityType, carrying the effect-receipt marker.
export const dbMigrated = {
  lexicon: "test",
  entityType: "Test::Receipt",
  name: "dbMigrated",
  effect: "db-migrate",
  flavor: "existence",
  inputs: {},
  [Symbol.for("chant.declarable")]: true,
  [Symbol.for("chant.effect-receipt")]: true,
};
`;

describe("effect-receipt apply write-exclusion (#1832)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-receipt-excl-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("the serializer's apply-bound entity map never contains the receipt; it rides ctx.receipts", async () => {
    await writeFile(join(testDir, "infra.infra.ts"), RECEIPT_FIXTURE);

    const seen: Array<{ entities: string[]; receipts: string[] }> = [];
    const serializer: Serializer = {
      name: "test",
      rulePrefix: "TEST",
      serialize: (entities, _outputs, context?: SerializeContext) => {
        seen.push({
          entities: [...entities.keys()],
          receipts: [...(context?.receipts?.keys() ?? [])],
        });
        return JSON.stringify({ resources: [...entities.keys()] });
      },
    };

    const result = await build(testDir, [serializer]);

    expect(result.errors).toEqual([]);
    expect(result.entities.has("dbMigrated")).toBe(true); // declared, diffed, observed like any resource
    expect(seen).toHaveLength(1);
    expect(seen[0].entities).toEqual(["bucket"]); // withheld from the apply-bound set
    expect(seen[0].receipts).toEqual(["dbMigrated"]); // still visible to the serializer (#1835)
  });

  test("a mock-plugin apply driven from the build output never writes the receipt and never prunes it", async () => {
    await writeFile(join(testDir, "infra.infra.ts"), RECEIPT_FIXTURE);

    // The mock plugin's serializer: apply-bound resources into the document
    // appliers consume; the receipts core withheld into a visibility section
    // OUTSIDE it, the way #1835's materialization renders them.
    const serializer: Serializer = {
      name: "test",
      rulePrefix: "TEST",
      serialize: (entities, _outputs, context?: SerializeContext) =>
        JSON.stringify({
          resources: [...entities.keys()],
          receiptVisibility: [...(context?.receipts?.keys() ?? [])],
        }),
    };
    const result = await build(testDir, [serializer]);
    expect(result.errors).toEqual([]);

    // The mock plugin's applier — the generic shape every lexicon applier
    // has: desired set from the document's apply-bound section, writes for
    // desired, prune candidates from owned live resources absent from
    // desired minus the receipts the seam declared. The live scope holds the
    // declared bucket, a genuine owned orphan, and the receipt the effect
    // step wrote.
    const writes: string[] = [];
    const pruneCandidates: string[] = [];
    const mockApply = (manifest: string, live: Array<{ name: string; owned: boolean }>): void => {
      const doc = JSON.parse(manifest) as { resources: string[]; receiptVisibility: string[] };
      const desired = new Set<string>(doc.resources);
      const receipts = new Set<string>(doc.receiptVisibility);
      for (const name of desired) writes.push(name);
      for (const r of live) {
        if (r.owned && !desired.has(r.name) && !receipts.has(r.name)) pruneCandidates.push(r.name);
      }
    };

    mockApply(result.outputs.get("test") as string, [
      { name: "bucket", owned: true },
      { name: "orphan", owned: true },
      { name: "dbMigrated", owned: true },
    ]);

    // The applier was never handed the receipt: it cannot write it.
    expect(writes).toEqual(["bucket"]);
    expect(writes).not.toContain("dbMigrated");
    // The genuine orphan is a prune candidate; the receipt never is.
    expect(pruneCandidates).toEqual(["orphan"]);
    // And the core seam is what made both true: the apply-bound split
    // recognized the receipt by its marker alone.
    const { applyBound } = splitReceiptEntities(result.entities as Map<string, Declarable>);
    expect(applyBound.has("dbMigrated")).toBe(false);
  });

  test("a partition holding only core-factory receipts serializes nothing apply-bound and warns about nothing", async () => {
    // The core factory's receipts live in the "chant" pseudo-lexicon, which
    // has no serializer until a lexicon materializes them (#1835). That is
    // the designed shape, not a missing-serializer warning.
    await writeFile(
      join(testDir, "infra.infra.ts"),
      `
export const bucket = {
  lexicon: "test",
  entityType: "Test::Bucket",
  props: {},
  [Symbol.for("chant.declarable")]: true,
};

export const migrated = {
  lexicon: "chant",
  entityType: "Chant::EffectReceipt",
  name: "migrated",
  effect: "migrate",
  flavor: "existence",
  inputs: {},
  [Symbol.for("chant.declarable")]: true,
  [Symbol.for("chant.effect-receipt")]: true,
};
`,
    );

    const serializer: Serializer = {
      name: "test",
      rulePrefix: "TEST",
      serialize: (entities) => JSON.stringify({ resources: [...entities.keys()] }),
    };
    const result = await build(testDir, [serializer]);

    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((w) => w.includes("chant"))).toEqual([]);
    expect(result.outputs.has("chant")).toBe(false);
    expect((result.outputs.get("test") as string).includes("migrated")).toBe(false);
  });

  test("splitReceiptEntities partitions a mixed map by the marker alone", () => {
    const receipt = EffectReceipt("r", { effect: "e", flavor: "existence" });
    const plain = {
      lexicon: "test",
      entityType: "Test::Bucket",
      props: {},
      [Symbol.for("chant.declarable")]: true,
    } as unknown as Declarable;
    const { applyBound, receipts } = splitReceiptEntities(
      new Map<string, Declarable>([
        ["r", receipt],
        ["b", plain],
      ]),
    );
    expect([...applyBound.keys()]).toEqual(["b"]);
    expect([...receipts.keys()]).toEqual(["r"]);
  });
});
