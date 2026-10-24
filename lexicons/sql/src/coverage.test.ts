import { describe, expect, test } from "vitest";
import { KIND_COVERAGE, PINNED_COMMANDS, kindCoverageProblems, pinnedCommandsCurrent, statementKind } from "./coverage";
import { POSTGRES_PROBES } from "./postgres/live/undeclarable";
import { CLICKHOUSE_PROBES } from "./clickhouse/live/undeclarable";
import { SQL_DIALECTS } from "./dialects";
import { POSTGRES_ENTITY_TYPES } from "./postgres/entity-types";
import { CLICKHOUSE_ENTITY_TYPES } from "./clickhouse/entities";

describe("the object coverage table (#3911)", () => {
  test.each(SQL_DIALECTS)("%s: every CREATE command a pinned server has is marked, and nothing else", (dialect) => {
    expect(kindCoverageProblems(dialect)).toEqual([]);
  });

  test.each(SQL_DIALECTS)("%s: the command lists are the pinned servers' (run scripts/sql-create-commands.ts after a pin move)", (dialect) => {
    expect(pinnedCommandsCurrent(dialect)).toEqual([]);
  });

  test("a pinned server with a command no row covers fails the check", () => {
    const pins = [{ version: "19.0", commands: [...PINNED_COMMANDS.postgres[0]!.commands, "CREATE PROPERTY GRAPH"] }];
    expect(kindCoverageProblems("postgres", { pins })).toContain("postgres 19.0 has CREATE PROPERTY GRAPH, and no row in src/coverage/postgres.json covers it");
  });

  test("a row must say why it is not declared, and name its entity when it is", () => {
    const rows = [
      { command: "CREATE CAST", kind: "cast", status: "refused" as const },
      { command: "CREATE TABLE", kind: "table", status: "declared" as const },
    ];
    expect(kindCoverageProblems("postgres", { pins: [{ version: "x", commands: ["CREATE CAST", "CREATE TABLE"] }], rows })).toEqual([
      "cast is refused, and gives no reason",
      "table is declared, and names no entity type",
    ]);
  });

  test("a declared row names an entity type the dialect has, and every entity type but a grant has a declared row", () => {
    // A grant is a GRANT statement, not a CREATE command, so no row is about it.
    const types = {
      postgres: { all: Object.values(POSTGRES_ENTITY_TYPES) as string[], notCreate: ["Postgres::Grant", "Postgres::DefaultPrivileges"] },
      clickhouse: { all: Object.values(CLICKHOUSE_ENTITY_TYPES) as string[], notCreate: ["ClickHouse::Grant"] },
    };
    for (const dialect of SQL_DIALECTS) {
      const entities = KIND_COVERAGE[dialect].filter((r) => r.status === "declared").map((r) => r.entity!);
      for (const e of entities) expect(types[dialect].all, `${dialect} row entity ${e}`).toContain(e);
      for (const e of types[dialect].all.filter((t) => !types[dialect].notCreate.includes(t))) expect(entities, `${dialect} entity type ${e} has no declared row`).toContain(e);
    }
  });

  test("a kind that is declared, referenced, refused or out of scope is told apart: only a declared row names an entity", () => {
    for (const dialect of SQL_DIALECTS) {
      for (const r of KIND_COVERAGE[dialect]) {
        if (r.status === "declared") expect(r.reason, `${dialect} ${r.kind}`).toBeUndefined();
        else expect(r.entity, `${dialect} ${r.kind}`).toBeUndefined();
      }
    }
  });

  test("every refused or referenced kind has the live query that finds it, and every query a row", () => {
    const probes = { postgres: POSTGRES_PROBES, clickhouse: CLICKHOUSE_PROBES };
    for (const dialect of SQL_DIALECTS) {
      const refused = KIND_COVERAGE[dialect].filter((r) => r.status === "refused" || r.status === "referenced").map((r) => r.kind);
      for (const kind of refused) expect(Object.keys(probes[dialect]), `${dialect} ${kind}`).toContain(kind);
      const kinds = KIND_COVERAGE[dialect].map((r) => r.kind);
      for (const kind of Object.keys(probes[dialect])) expect(kinds, `${dialect} probe ${kind}`).toContain(kind);
    }
  });
});

describe("a statement's kind", () => {
  test.each([
    ["CREATE TYPE app.pair AS (a int, b text)", "composite type"],
    ["CREATE TYPE app.r AS RANGE (subtype = float8)", "range type"],
    ["CREATE TYPE app.mood AS ENUM ('ok')", "enum type"],
    ["CREATE TYPE app.shell", "base type"],
    ["CREATE AGGREGATE app.total(int) (sfunc = int4pl, stype = int)", "aggregate"],
    ["CREATE CAST (app.pair AS text) WITH FUNCTION app.f(app.pair)", "cast"],
    ["CREATE OR REPLACE TRUSTED PROCEDURAL LANGUAGE plx", "procedural language"],
    ["CREATE DEFAULT CONVERSION c FOR 'LATIN1' TO 'UTF8' FROM f", "conversion"],
    ["CREATE OPERATOR CLASS c FOR TYPE int USING btree AS OPERATOR 1 <", "operator class"],
    ["CREATE TEXT SEARCH CONFIGURATION app.eng (COPY = english)", "text search configuration"],
    ["CREATE USER MAPPING FOR app SERVER s", "user mapping"],
    ["CREATE UNIQUE INDEX i ON app.t (a)", "index"],
    // A body's RETURN is inside its string, not a SQL-standard body.
    ["CREATE FUNCTION app.f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$", "function"],
    ["CREATE FUNCTION app.f(a int) RETURNS int LANGUAGE sql RETURN a + 1", "routine with a SQL-standard body"],
  ])("postgres: %s is a %s", (sql, kind) => {
    expect(statementKind("postgres", sql)?.kind).toBe(kind);
  });

  test.each([
    ["CREATE TEMPORARY TABLE t (a Int8)", "temporary table"],
    ["CREATE TABLE t (a Int8) ENGINE = Memory", "table"],
    ["CREATE WINDOW VIEW w AS SELECT 1", "window view"],
    ["CREATE SETTINGS PROFILE p SETTINGS max_threads = 1", "settings profile"],
    ["CREATE OR REPLACE FUNCTION f AS (x) -> x + 1", "SQL function"],
    ["CREATE QUOTA q FOR INTERVAL 1 hour MAX queries = 10", "quota"],
    ["CREATE NAMED COLLECTION IF NOT EXISTS c AS url = 'x'", "named collection"],
  ])("clickhouse: %s is a %s", (sql, kind) => {
    expect(statementKind("clickhouse", sql)?.kind).toBe(kind);
  });

  test("a statement that is not a CREATE has no kind", () => {
    expect(statementKind("postgres", "ALTER TABLE t ADD COLUMN a int")).toBeUndefined();
  });
});
