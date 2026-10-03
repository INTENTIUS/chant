import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { sqlPlugin, sqlSerializer } from "@intentius/chant-lexicon-sql";
import { postSynthChecks } from "../src/lint/post-synth";

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
    "postgres-saas": {
      checks: (output) => {
        const doc = JSON.parse(output) as Doc & { dialect: string };
        expect(doc.dialect).toBe("postgres");
        // Every tenant table's key starts with tenant_id, and a tasks foreign key carries it.
        for (const t of ["users", "projects", "tasks"]) {
          expect((objectOf(doc, t).primaryKey as { columns: string[] }).columns[0], t).toBe("tenant_id");
        }
        expect(objectOf(doc, "tasks")).toMatchObject({
          foreignKeys: [
            { columns: ["tenant_id", "project_id"], refTable: "app.projects", refColumns: ["tenant_id", "id"], onDelete: "CASCADE" },
            { columns: ["tenant_id", "assignee_id"], refTable: "app.users", refColumns: ["tenant_id", "id"] },
          ],
        });
        for (const i of ["tasksByProject", "tasksByAssignee"]) {
          expect((objectOf(doc, i).elements as Array<{ column?: string }>)[0]?.column, i).toBe("tenant_id");
        }
        const at = (n: string) => doc.applyOrder.indexOf(n);
        expect(at("tenants")).toBeLessThan(at("projects"));
        expect(at("projects")).toBeLessThan(at("tasks"));
        expect(at("tasks")).toBeLessThan(at("openTasks"));
        expect(objectOf(doc, "openTasks").with).toContain("security_invoker");
      },
    },
    "postgres-partitioned-events": {
      checks: (output) => {
        const doc = JSON.parse(output) as Doc & { dialect: string };
        expect(objectOf(doc, "events")).toMatchObject({ partitionBy: "RANGE (occurred_at)" });
        const at = (n: string) => doc.applyOrder.indexOf(n);
        for (const p of ["eventsOct", "eventsNov", "eventsDec", "eventsDefault"]) {
          expect(at(p), p).toBeGreaterThan(at("events"));
          expect(objectOf(doc, p).partitionOf, p).toBeDefined();
        }
        expect(objectOf(doc, "eventsOct")).toMatchObject({ partitionBound: "FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')" });
        expect(objectOf(doc, "events").primaryKey).toMatchObject({ columns: ["id", "occurred_at"] });
        expect(at("eventsByDevice")).toBeGreaterThan(at("events"));
      },
    },
    "postgres-column-rename": {
      checks: (output) => {
        const doc = JSON.parse(output) as Doc & { dialect: string };
        expect(doc.dialect).toBe("postgres");
        expect(doc.applyOrder).toEqual(["app", "users"]);
        expect((objectOf(doc, "users").columns as Array<{ name: string }>).map((c) => c.name)).toEqual(["id", "login", "created_at"]);
      },
    },
    "postgres-composites": {
      checks: (output) => {
        const doc = JSON.parse(output) as Doc & { dialect: string };
        expect(doc.dialect).toBe("postgres");
        const at = (n: string) => doc.applyOrder.indexOf(n);
        expect(at("app")).toBe(0);
        // Each member after what it references.
        expect(at("membershipsTable")).toBeGreaterThan(at("usersTable"));
        expect(at("membershipsTable")).toBeGreaterThan(at("teamsTable"));
        expect(at("membershipsReverseIndex")).toBeGreaterThan(at("membershipsTable"));
        expect(at("teamSizesView")).toBeGreaterThan(at("membershipsTable"));
        expect(at("teamSizesUniqueIndex")).toBeGreaterThan(at("teamSizesView"));
        expect(at("auditDefaultPartition")).toBeGreaterThan(at("auditTable"));
        expect(objectOf(doc, "documentsTable").primaryKey).toMatchObject({ columns: ["tenant_id", "id"] });
        expect((objectOf(doc, "usersTable").columns as Array<{ name: string }>).slice(-3).map((c) => c.name)).toEqual([
          "created_at",
          "updated_at",
          "deleted_at",
        ]);
      },
    },
    "postgres-cdc-source": {
      checks: (output) => {
        const doc = JSON.parse(output) as Doc & { dialect: string };
        expect(doc.dialect).toBe("postgres");
        expect(doc.applyOrder).toEqual(["shop", "customers", "orders", "ordersByCustomer"]);
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

const columnNames = (doc: Doc, name: string) => (objectOf(doc, name).columns as Array<{ name: string }>).map((c) => c.name);

describe("the Postgres source and the ClickHouse mirror are two projects with one set of columns", () => {
  test("each table the CDC mirror carries has the columns its Postgres source declares", async () => {
    const built = async (example: string) => {
      const result = await build(join(import.meta.dirname, example, "src"), [sqlSerializer], undefined, {
        fold: true,
        intrinsics: sqlPlugin.intrinsics!(),
        lexicons: ["sql"],
      });
      expect(result.errors).toEqual([]);
      return docOf((result.outputs.get("sql") as { primary: string }).primary);
    };
    const source = await built("postgres-cdc-source");
    const mirror = await built("cdc-mirror");
    // The mirror adds the pipeline's version and deleted columns.
    for (const [pg, ch] of [["customers", "customersTable"], ["orders", "ordersTable"]] as const) {
      expect(columnNames(mirror, ch).filter((c) => !c.startsWith("_")), pg).toEqual(columnNames(source, pg));
    }
  });
});

describe("the postgres-column-rename example's Op", () => {
  test("builds as one Op that renames app.users.login by expand and contract", async () => {
    const result = await build(join(import.meta.dirname, "postgres-column-rename", "src"), [sqlSerializer], undefined, {
      fold: true,
      intrinsics: sqlPlugin.intrinsics!(),
      lexicons: ["sql"],
    });
    expect(result.errors).toEqual([]);
    const op = result.entities.get("op") as unknown as { entityType: string; props?: { name?: string; phases?: Array<{ name: string }>; labels?: Record<string, string> } };
    expect(op).toBeDefined();
    expect(op.props?.name).toBe("rename-users-username-to-login");
    expect(op.props?.labels).toMatchObject({ Table: "app.users", Column: "login" });
    expect(op.props?.phases?.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Plan", "Expand", "Dual write", "Backfill", "Verify", "Approve", "Switch", "Retain", "Contract"]),
    );
  });
});

describe("the Postgres examples pass SQLPG101 to SQLPG118", () => {
  test.each([
    "postgres-getting-started",
    "postgres-saas",
    "postgres-partitioned-events",
    "postgres-column-rename",
    "postgres-composites",
    "postgres-cdc-source",
  ])("%s", async (example) => {
    const result = await build(join(import.meta.dirname, example, "src"), [sqlSerializer], undefined, {
      fold: true,
      intrinsics: sqlPlugin.intrinsics!(),
      lexicons: ["sql"],
    });
    expect(result.errors).toEqual([]);
    const ctx = makePostSynthCtx("sql", (result.outputs.get("sql") as { primary: string }).primary, result.entities);
    const checks = postSynthChecks.filter((c) => c.id.startsWith("SQLPG"));
    expect(checks.map((c) => c.id).sort()).toHaveLength(18);
    expect(checks.flatMap((c) => c.check(ctx).map((d) => `${c.id} ${d.message}`))).toEqual([]);
  });
});
