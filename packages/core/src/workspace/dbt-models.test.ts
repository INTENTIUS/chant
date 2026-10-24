/**
 * A dbt member's models as outputs (#3935): the `dbt-project` reader's
 * `outputs`, the schema rules, and `chant workspace check` over a downstream
 * member that links to a model.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, REPO, repo } from "./__fixtures__/contract-repo";
import { runDeclarationChecks } from "./checks";
import { parseDeclaration } from "./declaration";
import { readDbtProject } from "./dbt-project-reader";
import { resolveLinks, withReaderOutputs, type MemberHandles } from "./links";
import { workingTree } from "./tree";

afterAll(cleanScratch);

const SQL_KINDS = readFileSync(join(REPO, "lexicons", "sql", "workspace-kinds.json"), "utf-8");
const SQL_PACKAGE = JSON.stringify({ name: "@intentius/chant-lexicon-sql", version: "0.0.0", exports: { "./workspace-kinds": "./workspace-kinds.json" } });

const read = (files: Record<string, string>, fields: Record<string, unknown> = {}) => {
  const root = repo({ "dbt_project.yml": "name: p\n", ...files });
  return readDbtProject({ member: { name: "p" } as never, dir: "", fields: { sqlMember: null, dialect: "postgres", modelSchema: null, ...fields } as never, tree: workingTree(root) });
};
const names = (r: ReturnType<typeof read>) => (r.outputs ?? []).map((o) => o.name);

const ORDERS_SQL = "select 1 as id\n";
const ORDERS_YML = "version: 2\nmodels:\n  - name: orders\n    columns:\n      - name: id\n      - name: Total\n";

describe("model outputs with modelSchema (#3935)", () => {
  test("each model is <modelSchema>.<model>, and each column its YAML lists is <modelSchema>.<model>.<column>", () => {
    const r = read({ "models/orders.sql": ORDERS_SQL, "models/marts/customers.sql": ORDERS_SQL, "models/schema.yml": ORDERS_YML }, { modelSchema: "analytics" });
    expect(names(r)).toEqual(["analytics.customers", "analytics.orders", "analytics.orders.id", "analytics.orders.total"]);
    expect(r.gaps).toEqual([]);
    expect(r.outputs!.find((o) => o.name === "analytics.orders")).toMatchObject({ file: "models/orders.sql", line: 1 });
    expect(r.outputs!.find((o) => o.name === "analytics.orders.id")).toMatchObject({ file: "models/schema.yml", line: 5 });
  });

  test("dbt config is not read for the schema when modelSchema is set, even a templated one", () => {
    const r = read(
      { "models/a.sql": "{{ config(schema=var('s')) }}\nselect 1\n", "dbt_project.yml": "name: p\nmodels:\n  p:\n    +schema: \"{{ target.name }}\"\n" },
      { modelSchema: "analytics" },
    );
    expect(names(r)).toEqual(["analytics.a"]);
    expect(r.gaps).toEqual([]);
  });

  test("alias overrides the model name, from config(), the YAML or dbt_project.yml; the closest wins", () => {
    const r = read(
      {
        "dbt_project.yml": "name: p\nmodels:\n  p:\n    marts:\n      +alias: from_project\n",
        "models/marts/a.sql": "select 1\n",
        "models/marts/b.sql": "select 1\n",
        "models/marts/c.sql": "{{ config(alias='from_sql') }}\nselect 1\n",
        "models/marts/m.yml": "models:\n  - name: b\n    config:\n      alias: from_yaml\n  - name: c\n    config:\n      alias: from_yaml\n",
      },
      { modelSchema: "s" },
    );
    expect(names(r)).toEqual(["s.from_project", "s.from_yaml", "s.from_sql"]);
  });

  test("a templated alias is a gap at the model's file and line, and the model is left out", () => {
    const r = read({ "models/a.sql": "select 1\n\n{{ config(alias=var('x')) }}\n", "models/b.sql": "select 1\n" }, { modelSchema: "s" });
    expect(names(r)).toEqual(["s.b"]);
    expect(r.gaps).toEqual([expect.objectContaining({ file: "models/a.sql", line: 3, outputs: true, message: expect.stringMatching(/^model a: alias var\('x'\) \(the model's config\(\)\) is a Jinja template/) })]);
  });

  test("a disabled model is left out, by config(), the YAML or the project", () => {
    const r = read(
      {
        "dbt_project.yml": "name: p\nmodels:\n  p:\n    old:\n      +enabled: false\n",
        "models/old/x.sql": "select 1\n",
        "models/y.sql": "{{ config(enabled=false) }}\nselect 1\n",
        "models/z.sql": "select 1\n",
        "models/m.yml": "models:\n  - name: z\n    config:\n      enabled: false\n  - name: w\n",
        "models/w.sql": "select 1\n",
      },
      { modelSchema: "s" },
    );
    expect(names(r)).toEqual(["s.w"]);
  });

  test("postgres keeps a quoted name as written and folds an unquoted one; clickhouse keeps every name", () => {
    const files = { "models/Orders.sql": "select 1\n", "models/m.yml": "models:\n  - name: Orders\n    columns:\n      - name: CustomerId\n      - name: OrderId\n        quote: true\n" };
    expect(names(read(files, { modelSchema: "Shop" }))).toEqual(["Shop.Orders", "Shop.Orders.customerid", "Shop.Orders.OrderId"]);
    expect(names(read({ ...files, "dbt_project.yml": "name: p\nquoting:\n  schema: false\n  identifier: false\n" }, { modelSchema: "Shop" }))).toEqual(["shop.orders", "shop.orders.customerid", "shop.orders.OrderId"]);
    expect(names(read(files, { modelSchema: "Shop", dialect: "clickhouse" }))).toEqual(["Shop.Orders", "Shop.Orders.CustomerId", "Shop.Orders.OrderId"]);
  });

  test("model-paths say where models live", () => {
    const r = read({ "dbt_project.yml": "name: p\nmodel-paths: [transform]\n", "models/a.sql": "select 1\n", "transform/b.sql": "select 1\n" }, { modelSchema: "s" });
    expect(names(r)).toEqual(["s.b"]);
  });
});

describe("model outputs without modelSchema (#3935)", () => {
  test("under dbt's default generate_schema_name a custom schema depends on the target: a gap that says to set modelSchema", () => {
    const r = read({ "dbt_project.yml": "name: p\nmodels:\n  p:\n    +schema: marts\n", "models/a.sql": "select 1\n" });
    expect(names(r)).toEqual([]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ file: "models/a.sql", line: 1, outputs: true });
    expect(r.gaps[0].message).toMatch(/schema "marts" \(\+schema in dbt_project\.yml\) is joined to the target's schema by dbt's default generate_schema_name \(<target_schema>_marts\), so the name depends on the target; set modelSchema on the dbt member/);
  });

  test("a model with no schema lands in the target's schema: a gap", () => {
    const r = read({ "models/a.sql": "select 1\n" });
    expect(r.gaps[0].message).toMatch(/it sets no schema, so it lands in the target's schema.*set modelSchema/);
  });

  test("a templated schema is a gap, whatever the macro", () => {
    const r = read({ "models/a.sql": "{{ config(schema=\"{{ var('s') }}\") }}\nselect 1\n" });
    expect(r.gaps[0].message).toMatch(/schema .* \(the model's config\(\)\) is a Jinja template, which chant does not render for a target; set modelSchema/);
  });

  const AS_IS = "{% macro generate_schema_name(custom_schema_name, node) -%}\n    {%- set default_schema = target.schema -%}\n    {%- if custom_schema_name is none -%}\n        {{ default_schema }}\n    {%- else -%}\n        {{ custom_schema_name | trim }}\n    {%- endif -%}\n{%- endmacro %}\n";

  test("with the usual generate_schema_name override, a custom schema names the model; config precedence is config(), YAML, project", () => {
    const r = read({
      "macros/schema.sql": AS_IS,
      "dbt_project.yml": "name: p\nmodels:\n  p:\n    +schema: from_project\n    marts:\n      +schema: marts\n",
      "models/a.sql": "select 1\n",
      "models/marts/b.sql": "select 1\n",
      "models/marts/c.sql": "select 1\n",
      "models/marts/d.sql": "{{ config(schema='from_sql') }}\nselect 1\n",
      "models/m.yml": "models:\n  - name: c\n    config:\n      schema: from_yaml\n  - name: d\n    config:\n      schema: from_yaml\n",
    });
    expect(names(r)).toEqual(["from_project.a", "marts.b", "from_yaml.c", "from_sql.d"]);
    expect(r.gaps).toEqual([]);
  });

  test("under the override, a model with no custom schema still lands in the target's schema: a gap", () => {
    const r = read({ "macros/schema.sql": AS_IS, "models/a.sql": "select 1\n" });
    expect(names(r)).toEqual([]);
    expect(r.gaps[0].message).toMatch(/lands in the target's schema/);
  });

  test("any other generate_schema_name override is not evaluated: every model is a gap at the macro's line", () => {
    const r = read({
      "macros/schema.sql": "-- ours\n{% macro generate_schema_name(custom_schema_name, node) -%}\n  {{ target.name }}_{{ custom_schema_name }}\n{%- endmacro %}\n",
      "dbt_project.yml": "name: p\nmodels:\n  p:\n    +schema: marts\n",
      "models/a.sql": "select 1\n",
    });
    expect(names(r)).toEqual([]);
    expect(r.gaps[0].message).toMatch(/overrides generate_schema_name \(macros\/schema\.sql:2\).*set modelSchema/);
  });

  test("modelSchema still names the models under an override chant can't evaluate", () => {
    const r = read({ "macros/schema.sql": "{% macro generate_schema_name(c, n) %}{{ target.name }}{% endmacro %}", "models/a.sql": "select 1\n" }, { modelSchema: "s" });
    expect(names(r)).toEqual(["s.a"]);
    expect(r.gaps).toEqual([]);
  });

  test("config() is found past comments and across lines; a config call in a comment is not read", () => {
    const r = read(
      { "models/a.sql": "-- {{ config(alias='no') }}\n{#- {{ config(alias='nor') }} -#}\n{{\n  config(\n    materialized='table',\n    alias='yes'\n  )\n}}\nselect 1\n" },
      { modelSchema: "s" },
    );
    expect(names(r)).toEqual(["s.yes"]);
  });
});

describe("withReaderOutputs (#3935)", () => {
  const base: MemberHandles = { member: "analytics", outputs: [{ name: "kept" }], inputs: [], complete: true, why: null, exposesNone: false };
  test("adds the reader's outputs, keeps the member's own and does not repeat a name", () => {
    const out = withReaderOutputs(new Map([["analytics", base]]), new Map([["analytics", { reader: "dbt-project" as const, links: [], gaps: [], outputs: [{ name: "s.a", file: "f", line: 1 }, { name: "kept", file: "f", line: 1 }] }]]));
    expect(out.get("analytics")!.outputs.map((o) => o.name)).toEqual(["kept", "s.a"]);
    expect(out.get("analytics")!.complete).toBe(true);
  });
  test("a gap flagged outputs makes the member incomplete, and a link to a name it lacks is unresolved", () => {
    const out = withReaderOutputs(new Map([["analytics", base]]), new Map([["analytics", { reader: "dbt-project" as const, links: [], gaps: [{ file: "m.sql", line: 1, message: "model a: x", outputs: true }, { file: "s.yml", line: 1, message: "a source gap" }], outputs: [] }]]));
    expect(out.get("analytics")).toMatchObject({ complete: false, why: "model a: x" });
  });
  test("returns the handles as they are when no reader reports outputs", () => {
    const handles = new Map([["analytics", base]]);
    expect(withReaderOutputs(handles, new Map([["analytics", { reader: "dbt-project" as const, links: [], gaps: [{ file: "s.yml", line: 1, message: "a source gap" }] }]]))).toBe(handles);
    expect(withReaderOutputs(handles, undefined)).toBe(handles);
  });
  test("resolveLinks resolves a declared link to a reader output", () => {
    const decl = parseDeclaration(
      declaration([
        { name: "analytics", dir: "analytics", kind: "other", because: "x" },
        { name: "dash", dir: "dash", kind: "other", because: "x", links: [{ member: "analytics", output: "s.a" }] },
      ]),
      "chant.workspace.json",
    );
    const handles = new Map([["analytics", base]]);
    const read = new Map([["analytics", { reader: "dbt-project" as const, links: [], gaps: [], outputs: [{ name: "s.a", file: "f", line: 1 }] }]]);
    expect(resolveLinks(decl, handles, undefined, read)[0]).toMatchObject({ origin: "declared", status: "resolved" });
    expect(resolveLinks(decl, handles)[0]).toMatchObject({ status: "missing" });
  });
});

describe("a downstream member links to a dbt model, in chant workspace check (#3935)", () => {
  const workspace = (opts: { models?: Record<string, string>; fields?: Record<string, unknown>; output?: string } = {}) =>
    repo({
      "chant.workspace.json": declaration(
        [
          { name: "analytics", dir: "analytics", kind: "dbt", fields: opts.fields ?? { modelSchema: "analytics" } },
          { name: "dash", dir: "dash", kind: "other", because: "reads a model", suppress: [{ check: "WSP009", because: "a stand-in" }], links: [{ member: "analytics", output: opts.output ?? "analytics.orders" }] },
        ],
        { pins: [{ path: "plugins/sql" }] },
      ),
      "plugins/sql/package.json": SQL_PACKAGE,
      "plugins/sql/workspace-kinds.json": SQL_KINDS,
      "dash/README": "",
      "analytics/dbt_project.yml": "name: analytics\n",
      "analytics/models/orders.sql": ORDERS_SQL,
      "analytics/models/orders.yml": ORDERS_YML,
      ...(opts.models ?? {}),
    });

  test("a link to a model and to a column resolves", async () => {
    for (const output of ["analytics.orders", "analytics.orders.id"]) {
      const report = await runDeclarationChecks(workspace({ output }));
      expect(report.diagnostics).toEqual([]);
      expect(report.links.find((r) => r.origin === "declared")).toMatchObject({ status: "resolved", producer: "analytics", output });
    }
  });

  test("removing the model fails check, naming the model and the outputs left", async () => {
    expect((await runDeclarationChecks(workspace())).ok).toBe(true);
    const gone = workspace();
    const fs = await import("node:fs");
    fs.rmSync(join(gone, "analytics/models/orders.sql"));
    fs.rmSync(join(gone, "analytics/models/orders.yml"));
    fs.writeFileSync(join(gone, "analytics/models/other.sql"), "select 1\n");
    const failed = await runDeclarationChecks(gone);
    expect(failed.ok).toBe(false);
    expect(failed.diagnostics.map((d) => `${d.ruleId}:${d.severity}:${d.entity}`)).toEqual(["WSP093:error:dash"]);
    expect(failed.diagnostics[0].message).toMatch(/analytics has no output analytics\.orders.*its outputs: analytics\.other/);
  });

  test("removing a column from the model's YAML fails check", async () => {
    const report = await runDeclarationChecks(workspace({ output: "analytics.orders.id", models: { "analytics/models/orders.yml": "models:\n  - name: orders\n" } }));
    expect(report.diagnostics.map((d) => d.ruleId)).toEqual(["WSP093"]);
  });

  test("a model the reader can't name leaves the member's outputs incomplete: the link is unresolved, not missing, and WSP099 says why", async () => {
    const report = await runDeclarationChecks(
      workspace({ fields: {}, output: "analytics.orders", models: { "analytics/dbt_project.yml": "name: analytics\nmodels:\n  analytics:\n    +schema: analytics\n" } }),
    );
    expect(report.links.find((r) => r.origin === "declared")).toMatchObject({ status: "unresolved" });
    const ids = report.diagnostics.map((d) => `${d.ruleId}:${d.severity}`);
    expect(ids).toContain("WSP099:info");
    expect(report.diagnostics.find((d) => d.ruleId === "WSP099")!.message).toMatch(/set modelSchema on the dbt member/);
  });
});
