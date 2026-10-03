import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { sqlPlugin, sqlSerializer } from "@intentius/chant-lexicon-sql";

interface Doc {
  applyOrder: string[];
  objects: Array<{ export: string; name: string; type: string; props?: Record<string, unknown>; lineage?: unknown; ddl?: string }>;
}
const docOf = (output: string) => JSON.parse(output) as Doc;
const objectOf = (doc: Doc, name: string) => {
  const o = doc.objects.find((x) => x.export === name);
  if (!o) throw new Error(`no object ${name}`);
  return o as Record<string, unknown>;
};

describeAllExamples(
  {
    lexicon: "sql",
    serializer: sqlSerializer,
    outputKey: "sql",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": {
      checks: (output) => {
        const doc = JSON.parse(output) as { applyOrder: string[]; objects: Array<{ export: string; lineage?: unknown }> };
        expect(doc.applyOrder).toEqual(["analytics", "dailyActive", "events", "dailyActiveMv", "users"]);
        expect(doc.objects.find((o) => o.export === "dailyActiveMv")?.lineage).toEqual([
          { output: "day", expr: "toDate(ts)", from: ["events.ts"] },
          { output: "kind", expr: "kind", from: ["events.kind"] },
          { output: "users", expr: "uniqState(user_id)", from: ["events.user_id"] },
        ]);
      },
    },
    "events-pipeline": {
      checks: (output) => {
        const doc = docOf(output);
        // Each rollup's view comes after the events table it reads and the target it writes.
        for (const r of ["dailyKinds", "dailyUsers"]) {
          expect(doc.applyOrder.indexOf(`${r}View`)).toBeGreaterThan(doc.applyOrder.indexOf("eventsTable"));
          expect(doc.applyOrder.indexOf(`${r}View`)).toBeGreaterThan(doc.applyOrder.indexOf(`${r}Table`));
        }
        expect(objectOf(doc, "eventsTable")).toMatchObject({ ttl: "ts + INTERVAL 30 DAY", partitionBy: "toYYYYMM(ts)" });
        expect(objectOf(doc, "dailyUsersTable")).toMatchObject({ engine: { name: "AggregatingMergeTree" } });
      },
    },
    "cdc-mirror": {
      checks: (output) => {
        const doc = docOf(output);
        expect(objectOf(doc, "ordersTable")).toMatchObject({
          engine: { name: "ReplacingMergeTree", args: ["_peerdb_version", "_peerdb_is_deleted"] },
        });
        // The report reads both live-row views, so it is created after them.
        const at = (n: string) => doc.applyOrder.indexOf(n);
        expect(at("revenueByCountry")).toBeGreaterThan(at("ordersCurrent"));
        expect(at("revenueByCountry")).toBeGreaterThan(at("customersCurrent"));
        expect(at("customersCurrent")).toBeGreaterThan(at("customersTable"));
      },
    },
    "sharded-cluster": {
      checks: (output) => {
        const doc = docOf(output);
        expect(doc.applyOrder).toEqual(["hitsLocal", "hitsDistributed"]);
        expect(objectOf(doc, "hitsDistributed")).toMatchObject({
          onCluster: "web",
          engine: { name: "Distributed", args: ["web", "currentDatabase()", "hits_local", "cityHash64(user_id)"] },
        });
      },
    },
    "postgres-getting-started": {
      checks: (output) => {
        const doc = JSON.parse(output) as Doc & { dialect: string };
        expect(doc.dialect).toBe("postgres");
        // The schema first; each table after what it references; the view after both tables; the index after its table.
        expect(doc.applyOrder).toEqual(["app", "invoiceSeq", "orderStatus", "users", "orders", "orderTotals", "ordersUserId"]);
        expect(objectOf(doc, "orders")).toMatchObject({
          foreignKeys: [{ columns: ["user_id"], references: "users", refTable: "app.users", refColumns: ["id"], onDelete: "CASCADE" }],
        });
        // The sequence is interpolated, so it is a dependency, and it renders as the catalog prints it.
        expect(objectOf(doc, "orders").dependsOn).toContain("invoiceSeq");
        expect((objectOf(doc, "orders").columns as Array<{ name: string; default?: string }>).find((c) => c.name === "invoice_no")?.default).toBe(
          "nextval('app.invoice_seq'::regclass)",
        );
        expect(objectOf(doc, "orderTotals").lineage).toEqual([
          { output: "user_id", expr: "u.id", from: ["users.id"] },
          { output: "email", expr: "u.email", from: ["users.email"] },
          { output: "order_count", expr: "count(o.id)", from: ["orders.id"] },
          { output: "total", expr: "coalesce(sum(o.amount), 0)", from: ["orders.amount"] },
        ]);
        expect(objectOf(doc, "users")).toMatchObject({ comment: "One row per account" });
      },
    },
    "rebuild-migration": {
      checks: (output) => {
        const doc = docOf(output);
        expect(doc.applyOrder).toEqual(["shop", "events"]);
        expect(objectOf(doc, "events")).toMatchObject({ orderBy: "(user_id, ts)" });
      },
    },
  },
);

describe("the rebuild-migration example's Op", () => {
  test("builds as one Op whose phases run the rebuild of shop.events", async () => {
    const result = await build(join(import.meta.dirname, "rebuild-migration", "src"), [sqlSerializer], undefined, {
      fold: true,
      intrinsics: sqlPlugin.intrinsics!(),
      lexicons: ["sql"],
    });
    expect(result.errors).toEqual([]);
    const op = result.entities.get("op") as unknown as { entityType: string; props?: { name?: string; phases?: Array<{ name: string }> } };
    expect(op).toBeDefined();
    expect(op.props?.name).toBe("rebuild-shop-events");
    expect(op.props?.phases?.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Plan", "Create", "Dual write", "Backfill", "Verify", "Swap", "Drop"]),
    );
  });
});
