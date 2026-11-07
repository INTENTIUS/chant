/**
 * #4612: delivery metrics from a product's own records, the report index and
 * the audit trail. `__fixtures__/terragucci-dora.json` holds a fixture and
 * the `dora.json` terragucci's own `buildDora` (report/dora.ts at terragucci
 * main d8878e4) wrote for it, with and without the audit trail and with no
 * sources. chant's numbers must be the same, byte for byte.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDelivery, buildRecordDelivery, type DeliveryAuditEntry, type DeliveryRecordSource, type Dora } from "./delivery";
import { assertProductWords } from "../ci-product-words";

const golden = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "terragucci-dora.json"), "utf-8")) as {
  now: string;
  sources: DeliveryRecordSource[];
  entries: DeliveryAuditEntry[];
  dora: Dora;
  noAudit: Dora;
  empty: Dora;
};
const options = { words: assertProductWords({ product: "terragucci" }), now: new Date(golden.now), stages: { plan: "tf-plan", drift: "tf-drift" } };

describe("buildRecordDelivery (#4612)", () => {
  test("gives terragucci's dora.json for its index and audit trail", () => {
    expect(buildRecordDelivery(golden.sources, golden.entries, options)).toEqual(golden.dora);
    expect(JSON.stringify(buildRecordDelivery(golden.sources, golden.entries, options))).toBe(JSON.stringify(golden.dora));
  });

  test("with no audit trail only drift counts, and with no sources the estate is empty, as terragucci's", () => {
    expect(buildRecordDelivery(golden.sources, undefined, options)).toEqual(golden.noAudit);
    expect(buildRecordDelivery([], [], options)).toEqual(golden.empty);
  });

  test("the fixture moves the numbers it is meant to: a gate split, a digest join, an open incident and a cleared one", () => {
    const d = buildRecordDelivery(golden.sources, golden.entries, options);
    const [p, q] = d.projects;
    expect(p!.lead_time).toEqual({ changes: 2, median_seconds: 4500, before_gate_seconds: 3300, at_gate_seconds: 900, after_gate_seconds: 300 });
    expect(q!.lead_time.changes).toBe(2);
    expect(q!.restore).toMatchObject({ open: 2, drift_restored: 1 });
    expect(d.schema).toBe("terragucci.dora/v1");
    expect(d).not.toHaveProperty("source");
  });

  test("the stage names are the product's: other names read no plan and no drift", () => {
    const other = buildRecordDelivery(golden.sources, golden.entries, { ...options, stages: { plan: "pulumi-preview", drift: "pulumi-drift" } });
    expect(other.estate.lead_time.changes).toBe(0);
    expect(other.estate.restore.drift_restored).toBe(0);
  });

  test("the ledger's file still says where it came from", () => {
    const d = buildDelivery({ members: [], waves: [], gates: [], approved: [], drift: [], prEnvs: [] } as never, { now: new Date(golden.now) });
    expect(d.source).toBe("ledger");
  });
});
