/**
 * The first and third Done-when boxes of #4399, on the example pair.
 *
 * `examples/postgres-cdc-source` translated with `--use-composites` gives the
 * `CdcMirror` calls of `examples/cdc-mirror`, apart from the choices the
 * review diagnostics ask for. And the two projects' column names no longer
 * need a test that compares them: the mirror links each column to the
 * Postgres member's output, so dropping a Postgres column fails the link.
 * The link check here is core's `resolveLinks`, the function behind WSP093;
 * `workspace.e2e.test.ts` runs `chant workspace check` itself.
 */

import { describe, expect, test } from "vitest";
import { parseDeclaration } from "@intentius/chant/workspace/declaration";
import { resolveLinks, type MemberHandles } from "@intentius/chant/workspace/links";
import type { Declarable } from "@intentius/chant/declarable";
import { CdcMirror } from "../../composites/cdc-mirror";
import { schema, table } from "../../postgres/entities";
import { sqlWorkspaceOutputs } from "../../workspace-outputs";
import * as source from "../../../examples/postgres-cdc-source/src/shop";
import * as mirrors from "../../../examples/cdc-mirror/src/mirrors";
import { mirrorColumns, orderBySql } from "./emit";
import { translatePostgres, type Mirror } from "./translate";

const sourceEntities = (): Map<string, Declarable> => new Map(Object.entries(source) as Array<[string, Declarable]>);
const ddl = (e: unknown): string => (e as { props: { ddl: string } }).props.ddl;

/**
 * The call for a mirror once its review is done. `types` replaces a column's
 * type, `call` adds the call's own props.
 */
function reviewed(m: Mirror, review: { types?: Record<string, string>; call?: Record<string, string> } = {}) {
  const columns = m.columns.map((c) => ({ ...c, type: review.types?.[c.name] ?? c.type }));
  return { name: m.name, columns: mirrorColumns({ ...m, columns }), primaryKey: orderBySql(m), ...review.call };
}

describe("postgres-cdc-source translated with --use-composites", () => {
  const t = translatePostgres(sourceEntities(), { composite: true });
  const byName = Object.fromEntries(t.mirrors.map((m) => [m.name, m]));

  test("is the two tables, keyed on their primary keys", () => {
    expect(t.mirrors.map((m) => m.name)).toEqual(["customers", "orders"]);
    expect(t.mirrors.map((m) => m.primaryKey)).toEqual([["id"], ["id"]]);
  });

  test("the call's columns are the mechanical type map, with the column comment kept", () => {
    expect(mirrorColumns(byName.customers!)).toBe("id Int64, email String COMMENT 'PII, hashed downstream', country String, created_at DateTime64(6, 'UTC')");
    expect(mirrorColumns(byName.orders!)).toBe("id Int64, customer_id Int64, total Decimal(12, 2), status String, placed_at DateTime64(6, 'UTC')");
  });

  test("customers is examples/cdc-mirror's declaration once country is LowCardinality (SQLRV004)", () => {
    const call = CdcMirror(reviewed(byName.customers!, { types: { country: "LowCardinality(String)" } }));
    expect(ddl(call.table)).toBe(ddl(mirrors.customers.table));
    expect(ddl(call.current)).toBe(ddl(mirrors.customers.current));
  });

  test("orders is examples/cdc-mirror's declaration once status is LowCardinality and the pipeline's names and partition are chosen (SQLRV004, SQLRV002)", () => {
    const call = CdcMirror(
      reviewed(byName.orders!, {
        types: { status: "LowCardinality(String)" },
        call: { version: "_peerdb_version", deleted: "_peerdb_is_deleted", partitionBy: "toYYYYMM(placed_at)" },
      }),
    );
    expect(ddl(call.table)).toBe(ddl(mirrors.orders.table));
    expect(ddl(call.current)).toBe(ddl(mirrors.orders.current));
  });

  test("each of those edits is asked for by an open diagnostic", () => {
    const at = (rule: string, entity: string, text: string) => t.diagnostics.some((d) => d.ruleId === rule && d.entity === entity && d.message.includes(text));
    expect(at("SQLRV004", "shop.customers", "shop.customers.country")).toBe(true);
    expect(at("SQLRV004", "shop.orders", "shop.orders.status")).toBe(true);
    expect(at("SQLRV002", "shop.orders", "ReplacingMergeTree(_version, _is_deleted)")).toBe(true);
  });

  test("the diagnostics are the decisions: no mechanical map writes one", () => {
    const rules = new Set(t.diagnostics.map((d) => d.ruleId));
    expect([...rules].sort()).toEqual(["SQLRV001", "SQLRV002", "SQLRV004", "SQLRV005", "SQLRV006", "SQLRV008", "SQLRV009", "SQLRV011"]);
    // No type diagnostic (SQLRV007): bigint, text, numeric(12, 2) and timestamptz are mechanical.
    expect(t.diagnostics.filter((d) => d.ruleId === "SQLRV007")).toEqual([]);
    // No Nullable finding: every column is NOT NULL or a key.
    expect(t.diagnostics.filter((d) => d.ruleId === "SQLRV003")).toEqual([]);
  });

  test("the foreign key from orders to customers and the index on orders are said not to be carried", () => {
    const fk = t.diagnostics.find((d) => d.ruleId === "SQLRV005");
    expect(fk).toMatchObject({ entity: "shop.orders", severity: "warning" });
    expect(fk!.message).toContain("REFERENCES shop.customers (id)");
    const ix = t.diagnostics.find((d) => d.ruleId === "SQLRV009");
    expect(ix!.message).toContain("orders_by_customer_idx");
  });

  test("the links are the Postgres outputs of every mirrored column", () => {
    expect(t.outputs).toEqual([
      "shop.customers.id",
      "shop.customers.email",
      "shop.customers.country",
      "shop.customers.created_at",
      "shop.orders.id",
      "shop.orders.customer_id",
      "shop.orders.total",
      "shop.orders.status",
      "shop.orders.placed_at",
    ]);
  });
});

/** The two projects as a workspace: `db` is the Postgres member, `mirror` links to each column. */
function workspace(entities: ReadonlyMap<string, Declarable>, links: readonly string[]) {
  const declaration = parseDeclaration(
    JSON.stringify({
      name: "shop",
      schema: 1,
      members: [
        { name: "db", dir: "postgres-cdc-source", kind: "chant" },
        { name: "mirror", dir: "cdc-mirror", kind: "chant", links: links.map((output) => ({ member: "db", output })) },
      ],
    }),
    "chant.workspace.json",
  );
  const report = sqlWorkspaceOutputs(entities as never)!;
  const handles = new Map<string, MemberHandles>([
    [
      "db",
      {
        member: "db",
        outputs: report.outputs.map((o) => ({ name: o.name, ...(o.previously?.length ? { previously: o.previously } : {}) })),
        inputs: [],
        complete: (report.gaps ?? []).length === 0,
        why: null,
        exposesNone: false,
      },
    ],
  ]);
  return resolveLinks(declaration, handles);
}

describe("the workspace link replaces the test that held the column names together", () => {
  const links = translatePostgres(sourceEntities(), { composite: true }).outputs;

  test("every link of the translated example resolves against the Postgres member", () => {
    const rows = workspace(sourceEntities(), links);
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => r.status)).toEqual(Array(9).fill("resolved"));
  });

  test("the mirror's hand-written column names are among the outputs, so a drift would show", () => {
    // examples/cdc-mirror declares these columns; each is a Postgres output.
    const declared = [...Object.values(mirrors)].flatMap((m) => ((m.table as unknown as { props: { columns: Array<{ name: string }> } }).props.columns.map((c) => c.name)));
    const outputs = new Set(sqlWorkspaceOutputs(sourceEntities() as never)!.outputs.map((o) => o.name));
    const named = declared.filter((n) => !n.startsWith("_"));
    expect(named.length).toBe(9);
    for (const n of named) expect([...outputs].some((o) => o.endsWith(`.${n}`)), n).toBe(true);
  });

  /** The customers declaration without email, as an author who drops the column would leave it. */
  function withoutEmail(): Map<string, Declarable> {
    const entities = sourceEntities();
    const shop = schema`CREATE SCHEMA shop`;
    entities.set("shop", shop as unknown as Declarable);
    entities.set(
      "customers",
      table`
        CREATE TABLE ${shop}.customers (
          id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          country    text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )` as unknown as Declarable,
    );
    return entities;
  }

  test("dropping a mirrored column from the Postgres declaration fails the mirror's link (WSP093)", () => {
    const rows = workspace(withoutEmail(), links);
    const missing = rows.filter((r) => r.status === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ consumer: "mirror", producer: "db", output: "shop.customers.email" });
    expect(missing[0]!.reason).toContain("db has no output shop.customers.email");
  });

  test("the link passes again once the mirror follows: migrate again, and the dropped column is gone from the links", () => {
    const entities = withoutEmail();
    const again = translatePostgres(entities, { composite: true });
    expect(again.outputs).not.toContain("shop.customers.email");
    expect(workspace(entities, again.outputs).every((r) => r.status === "resolved")).toBe(true);
  });

  test("renaming a column fails the link, and a previously hint says where it went", () => {
    const entities = sourceEntities();
    const shop = schema`CREATE SCHEMA shop`;
    entities.set("shop", shop as unknown as Declarable);
    entities.set(
      "customers",
      table`
        CREATE TABLE ${shop}.customers (
          id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          email_hash text NOT NULL, -- previously: email
          country    text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )` as unknown as Declarable,
    );
    const missing = workspace(entities, links).filter((r) => r.status === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.reason).toContain("renamed to shop.customers.email_hash");
  });
});
