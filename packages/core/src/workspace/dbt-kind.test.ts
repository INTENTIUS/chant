/**
 * The `dbt` member kind (#3932): the sql lexicon's kinds file, the
 * `dbt-project` link reader, and `chant workspace check` over the links it
 * finds. The producer here is an `other` member whose entry lists the
 * outputs a sql member exposes (#3931), so the reader's names are checked
 * against the naming contract without a sql project.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, declaration, REPO, repo } from "./__fixtures__/contract-repo";
import { runDeclarationChecks } from "./checks";
import { parseDeclaration } from "./declaration";
import { readDbtProject } from "./dbt-project-reader";
import { readKindLinks } from "./kind-link-readers";
import { createKindRegistry, parseKindData } from "./kinds";
import { graphLinks, resolveLinks, type LinkTableRow, type MemberHandles } from "./links";
import { workingTree } from "./tree";
import graphSchema from "./graph.schema.json";

afterAll(cleanScratch);

const SQL_KINDS = readFileSync(join(REPO, "lexicons", "sql", "workspace-kinds.json"), "utf-8");
const SQL_PACKAGE = JSON.stringify({ name: "@intentius/chant-lexicon-sql", version: "0.0.0", exports: { "./workspace-kinds": "./workspace-kinds.json" } });

const ORDERS = ["public.orders", "public.orders.id", "public.orders.customer_id", "public.orders.status"];

const SOURCES = `version: 2

sources:
  - name: shop
    schema: public
    tables:
      - name: orders
        columns:
          - name: id
          - name: customer_id
            description: who ordered
`;

interface Fixture {
  outputs?: string[];
  dbtFields?: Record<string, unknown>;
  members?: unknown[];
  files?: Record<string, string>;
}

/** A workspace with a `db` producer, a `analytics` dbt project and the sql lexicon's kinds pinned by path. */
function workspace(opts: Fixture = {}): string {
  return repo({
    "chant.workspace.json": declaration(
      [
        { name: "db", dir: "db", kind: "other", because: "stands in for a sql member (#3931)", suppress: [{ check: "WSP009", because: "a stand-in" }], outputs: opts.outputs ?? ORDERS },
        { name: "analytics", dir: "analytics", kind: "dbt", ...(opts.dbtFields === undefined ? { fields: { sqlMember: "db" } } : Object.keys(opts.dbtFields).length ? { fields: opts.dbtFields } : {}) },
        ...(opts.members ?? []),
      ],
      { pins: [{ path: "plugins/sql" }] },
    ),
    "plugins/sql/package.json": SQL_PACKAGE,
    "plugins/sql/workspace-kinds.json": SQL_KINDS,
    "db/README": "",
    "analytics/dbt_project.yml": "name: analytics\nversion: '1.0'\nprofile: analytics\n",
    "analytics/models/staging/sources.yml": SOURCES,
    ...(opts.files ?? {}),
  });
}

const rows = (links: LinkTableRow[]) =>
  links
    .filter((r) => r.origin === "kind-reader")
    .map((r) => (r.status === "ambiguous" ? `${r.consumer} -> ? ${r.input} ambiguous ${r.candidates.map((c) => c.producer).join("|")}` : `${r.consumer} -> ${r.producer}.${r.output} ${r.status} ${r.file}:${r.line}`));

describe("the dbt kind in the sql lexicon's kinds file (#3932)", () => {
  test("validates, probes dbt_project.yml and names the dbt-project reader", () => {
    const { kinds, problems } = parseKindData(SQL_KINDS, "@intentius/chant-lexicon-sql");
    expect(problems).toEqual([]);
    expect(kinds.map((k) => [k.name, k.reader, k.probe])).toEqual([["dbt", "dbt-project", { anyFile: ["dbt_project.yml"] }]]);
    expect(Object.keys(kinds[0].fields ?? {})).toEqual(["sqlMember", "dialect"]);
  });

  test("a reader this chant doesn't have keeps the kind without one, and says so", () => {
    const text = JSON.stringify({ schema: 1, kinds: [{ name: "lake", description: "a lake", precedence: 10, probe: { anyFile: ["lake.yml"] }, reader: "lake-tables" }] });
    const { kinds, problems } = parseKindData(text, "pkg");
    expect(kinds.map((k) => [k.name, k.reader])).toEqual([["lake", undefined]]);
    expect(problems).toEqual([expect.stringMatching(/kind lake names link reader lake-tables, which this chant does not have/)]);
  });
});

describe("dbt sources as links, in chant workspace check (#3932)", () => {
  test("each source table and column links to the sql member's <schema>.<table>[.<column>] output", async () => {
    const report = await runDeclarationChecks(workspace());
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
    expect(rows(report.links)).toEqual([
      "analytics -> db.public.orders resolved analytics/models/staging/sources.yml:7",
      "analytics -> db.public.orders.id resolved analytics/models/staging/sources.yml:9",
      "analytics -> db.public.orders.customer_id resolved analytics/models/staging/sources.yml:10",
    ]);
    expect(report.links[0]).toMatchObject({ origin: "kind-reader", reader: "dbt-project", kind: "output", resolves: "source" });
  });

  test("acceptance: dropping a column a source reads fails check and names the dbt source file and line", async () => {
    const report = await runDeclarationChecks(workspace({ outputs: ["public.orders", "public.orders.id", "public.orders.status"] }));
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.severity}:${d.entity}:${d.file}:${d.line}`)).toEqual([
      "WSP093:error:analytics:analytics/models/staging/sources.yml:10",
    ]);
    expect(report.diagnostics[0].message).toMatch(
      /^analytics's link to db output public\.orders\.customer_id \(read by dbt-project from analytics\/models\/staging\/sources\.yml:10\) does not resolve: db has no output public\.orders\.customer_id/,
    );
  });

  test("dropping the table fails the table and each column the source names", async () => {
    const report = await runDeclarationChecks(workspace({ outputs: ["public.customers"] }));
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.line}`)).toEqual(["WSP093:7", "WSP093:9", "WSP093:10"]);
  });

  test("a rename shows the old output missing with the near name", async () => {
    const report = await runDeclarationChecks(workspace({ outputs: ["public.orders", "public.orders.id", "public.orders.customerId"] }));
    expect(report.diagnostics[0].message).toMatch(/did you mean public\.orders\.customerId\? Links match exactly/);
  });

  test("a producer whose outputs can't all be read, such as a view's columns, keeps the link unresolved, not missing", () => {
    const decl = parseDeclaration(
      declaration([
        { name: "db", dir: "db", kind: "chant" },
        { name: "analytics", dir: "analytics", kind: "dbt" },
      ]),
      "chant.workspace.json",
    );
    const handles = new Map<string, MemberHandles>([
      ["db", { member: "db", outputs: [{ name: "public.orders" }], inputs: [], complete: false, why: "the columns of view public.orders can't be derived statically", exposesNone: false }],
    ]);
    const read = new Map([["analytics", { reader: "dbt-project" as const, gaps: [], producerField: "sqlMember", links: [{ member: null, output: "public.orders.customer_id", anchor: "public.orders", file: "analytics/models/s.yml", line: 4 }] }]]);
    const [row] = resolveLinks(decl, handles, undefined, read);
    expect(row).toMatchObject({ origin: "kind-reader", producer: "db", status: "unresolved", file: "analytics/models/s.yml", line: 4 });
    expect((row as { reason: string }).reason).toMatch(/whose outputs could not all be read in source \(the columns of view public\.orders/);
  });

  test("a column the sql member renamed says what it was renamed to (#3931's previously hint)", () => {
    const decl = parseDeclaration(
      declaration([
        { name: "db", dir: "db", kind: "chant" },
        { name: "analytics", dir: "analytics", kind: "dbt", fields: { sqlMember: "db" } },
      ]),
      "chant.workspace.json",
    );
    const handles = new Map<string, MemberHandles>([
      ["db", { member: "db", outputs: [{ name: "public.orders" }, { name: "public.orders.buyer_id", previously: ["public.orders.customer_id"] }], inputs: [], complete: true, why: null, exposesNone: false }],
    ]);
    const read = new Map([["analytics", { reader: "dbt-project" as const, gaps: [], producerField: "sqlMember", links: [{ member: "db", output: "public.orders.customer_id", anchor: "public.orders", file: "analytics/models/s.yml", line: 4 }] }]]);
    const [row] = resolveLinks(decl, handles, undefined, read);
    expect(row).toMatchObject({ origin: "kind-reader", status: "missing" });
    expect((row as { reason: string }).reason).toMatch(/it was renamed to public\.orders\.buyer_id, so link to that instead/);
  });

  test("without sqlMember, the one member that exposes the table is the producer", async () => {
    const report = await runDeclarationChecks(workspace({ dbtFields: {} }));
    expect(report.diagnostics).toEqual([]);
    expect(rows(report.links)[2]).toBe("analytics -> db.public.orders.customer_id resolved analytics/models/staging/sources.yml:10");
  });

  test("without sqlMember, a column dropped from the only producer still fails", async () => {
    const report = await runDeclarationChecks(workspace({ dbtFields: {}, outputs: ["public.orders", "public.orders.id"] }));
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.line}`)).toEqual(["WSP093:10"]);
  });

  test("without sqlMember, a table two members expose is ambiguous, and the message names the field", async () => {
    const report = await runDeclarationChecks(
      workspace({ dbtFields: {}, members: [{ name: "replica", dir: "replica", kind: "other", because: "a copy", suppress: [{ check: "WSP009", because: "a stand-in" }], outputs: ORDERS }], files: { "replica/README": "" } }),
    );
    expect(rows(report.links)[0]).toBe("analytics -> ? public.orders ambiguous db|replica");
    const ids = report.diagnostics.map((d) => `${d.ruleId}:${d.severity}:${d.file}:${d.line}`);
    expect(ids).toContain("WSP095:warning:analytics/models/staging/sources.yml:7");
    expect(report.diagnostics.find((d) => d.ruleId === "WSP095")!.message).toMatch(/set fields\.sqlMember on analytics to name it/);
  });

  test("a sqlMember that names no member is invalid, reported against the field", async () => {
    const report = await runDeclarationChecks(workspace({ dbtFields: { sqlMember: "warehouse" } }));
    expect(rows(report.links)[0]).toBe("analytics -> warehouse.public.orders invalid analytics/models/staging/sources.yml:7");
    expect(report.links.find((r) => r.origin === "kind-reader")!.reason).toMatch(/^fields\.sqlMember: member analytics links to warehouse, which is not a member/);
  });

  test("a templated schema is a gap (WSP099), never rendered, and its tables are not linked", async () => {
    const report = await runDeclarationChecks(
      workspace({
        files: {
          "analytics/models/raw.yml": "version: 2\nsources:\n  - name: raw\n    schema: \"{{ target.schema }}_raw\"\n    tables:\n      - name: events\n",
        },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.severity}:${d.file}:${d.line}`)).toEqual(["WSP099:info:analytics/models/raw.yml:4"]);
    expect(report.diagnostics[0].message).toMatch(/source raw: schema .* is a Jinja template or not a name; chant reads names as declared and never renders them for a target/);
    expect(rows(report.links).some((r) => r.includes("events"))).toBe(false);
  });
});

describe("the dbt-project reader (#3932)", () => {
  const read = (files: Record<string, string>, fields: Record<string, unknown> = {}) => {
    const root = repo({ "dbt_project.yml": "name: p\n", ...files });
    return readDbtProject({
      member: { name: "p" } as never,
      dir: "",
      fields: { sqlMember: null, dialect: "postgres", ...fields } as never,
      tree: workingTree(root),
    });
  };
  const outputs = (r: ReturnType<typeof read>) => r.links.map((l) => l.output);

  test("the schema defaults to the source name, as dbt's does, and identifier overrides the table name", () => {
    const r = read({ "models/s.yml": "sources:\n  - name: shop\n    tables:\n      - name: orders\n        identifier: orders_v2\n" });
    expect(outputs(r)).toEqual(["shop.orders_v2"]);
    expect(r.gaps).toEqual([]);
  });

  test("postgres: dbt quotes schema and identifier by default, so they keep their case; unquoted names fold", () => {
    const sources = (quoting: string) =>
      `sources:\n  - name: Shop\n${quoting}    tables:\n      - name: Orders\n        columns:\n          - name: CustomerId\n          - name: OrderId\n            quote: true\n`;
    expect(outputs(read({ "models/s.yml": sources("") }))).toEqual(["Shop.Orders", "Shop.Orders.customerid", "Shop.Orders.OrderId"]);
    expect(outputs(read({ "models/s.yml": sources("    quoting:\n      schema: false\n      identifier: false\n") }))).toEqual([
      "shop.orders",
      "shop.orders.customerid",
      "shop.orders.OrderId",
    ]);
    // dbt_project.yml's quoting applies below it.
    expect(outputs(read({ "dbt_project.yml": "name: p\nquoting:\n  identifier: false\n", "models/s.yml": sources("") }))[0]).toBe("Shop.orders");
  });

  test("clickhouse keeps every name as written; the source schema is the ClickHouse database", () => {
    const r = read({ "models/s.yml": "sources:\n  - name: events\n    schema: Analytics\n    tables:\n      - name: PageViews\n        columns:\n          - name: UserId\n" }, { dialect: "clickhouse" });
    expect(outputs(r)).toEqual(["Analytics.PageViews", "Analytics.PageViews.UserId"]);
  });

  test("model-paths say where sources live, and a disabled source or table is left out", () => {
    const r = read({
      "dbt_project.yml": "name: p\nmodel-paths: [transform]\n",
      "models/ignored.yml": "sources:\n  - name: a\n    tables:\n      - name: t\n",
      "transform/nested/s.yaml":
        "sources:\n  - name: b\n    tables:\n      - name: kept\n      - name: off\n        config:\n          enabled: false\n  - name: c\n    enabled: false\n    tables:\n      - name: t\n",
    });
    expect(outputs(r)).toEqual(["b.kept"]);
  });

  test("templated names are gaps with their lines, and the rest of the file is still read", () => {
    const r = read({
      "models/s.yml":
        "sources:\n  - name: shop\n    tables:\n      - name: orders\n        identifier: \"{{ var('orders') }}\"\n      - name: items\n        columns:\n          - name: \"{{ env_var('COL') }}\"\n          - name: sku\n",
    });
    expect(outputs(r)).toEqual(["shop.items", "shop.items.sku"]);
    expect(r.gaps.map((g) => `${g.file}:${g.line}`)).toEqual(["models/s.yml:5", "models/s.yml:8"]);
  });

  test("a table named like its source gets its own line; a column named like its table too", () => {
    const r = read({ "models/s.yml": "sources:\n  - name: orders\n    schema: public\n    tables:\n      - name: orders\n        columns:\n          - name: orders\n" });
    expect(r.links.map((l) => `${l.output}@${l.line}`)).toEqual(["public.orders@5", "public.orders.orders@7"]);
  });

  test("YAML that doesn't parse is a gap at its line", () => {
    const r = read({ "models/s.yml": "sources:\n  - name: a\n    tables: [\n" });
    expect(r.links).toEqual([]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].file).toBe("models/s.yml");
  });
});

describe("dbt links in chant workspace graph (#3932)", () => {
  test("graphLinks carries the reader's rows with their file and line, valid against graph.schema.json", () => {
    const root = workspace();
    const tree = workingTree(root);
    const decl = parseDeclaration(tree.read("chant.workspace.json"), "chant.workspace.json");
    const kinds = createKindRegistry(parseKindData(SQL_KINDS, "@intentius/chant-lexicon-sql").kinds);
    const links = graphLinks(decl, { composed: [], exports: [], imports: [] }, kinds, readKindLinks(decl, tree, kinds));
    expect(rows(links)).toEqual([
      "analytics -> db.public.orders resolved analytics/models/staging/sources.yml:7",
      "analytics -> db.public.orders.id resolved analytics/models/staging/sources.yml:9",
      "analytics -> db.public.orders.customer_id resolved analytics/models/staging/sources.yml:10",
    ]);
    const linkSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: (graphSchema as { $defs: object }).$defs, type: "array", items: { $ref: "#/$defs/link" } };
    contract(linkSchema).expectValid(links);
  });
});
