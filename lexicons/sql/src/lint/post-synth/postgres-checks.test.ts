import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlSerializer } from "../../serializer";
import { table as chTable } from "../../clickhouse/entities";
import { extension, index, schema, table, view } from "../../postgres/entities";
import { sqlAuditCatalog } from "../audit-catalog";
import { postSynthChecks } from "./index";

type Entities = Record<string, unknown>;

function run(id: string, entities: Entities) {
  const check = postSynthChecks.find((c: PostSynthCheck) => c.id === id)!;
  const out = sqlSerializer.serialize(new Map(Object.entries(entities)) as never) as SerializerResult;
  return check.check(makePostSynthCtx("sql", out.primary));
}

const flagged = (id: string, entities: Entities, text: RegExp) => {
  const diags = run(id, entities);
  expect(diags.length).toBeGreaterThan(0);
  expect(diags[0]).toMatchObject({ checkId: id, lexicon: "sql" });
  expect(diags[0]!.message).toMatch(text);
  return diags;
};

const clean = (id: string, entities: Entities) => expect(run(id, entities)).toEqual([]);

describe("registration", () => {
  const ids = postSynthChecks.map((c) => c.id).filter((id) => /^SQLPG1\d\d$/.test(id));
  test("at least 15 Postgres post-synth checks, each with an audit entry", () => {
    expect(ids.length).toBeGreaterThanOrEqual(15);
    for (const id of ids) expect(sqlAuditCatalog[id], id).toBeDefined();
  });
  test("the Postgres audit entries cover security, correctness and best practice", () => {
    const cats = new Set(ids.map((id) => sqlAuditCatalog[id]!.category));
    expect(cats).toEqual(new Set(["security", "correctness", "best-practice"]));
  });
  test("lineage credits name registered tools", () => {
    expect(sqlAuditCatalog.SQLPG103!.lineage?.[0]).toMatchObject({ tool: "squawk", rule: "prefer-identity" });
    expect(sqlAuditCatalog.SQLPG105!.lineage?.[0]).toMatchObject({ tool: "strong_migrations" });
  });
  test("a ClickHouse build is not read by the Postgres checks", () => {
    const ch = chTable`CREATE TABLE ch (a UInt8) ENGINE = MergeTree ORDER BY a`;
    for (const id of ids) expect(run(id, { ch }), id).toEqual([]);
  });
});

describe("SQLPG101: no primary key", () => {
  test("flags a table with none", () => {
    flagged("SQLPG101", { t: table`CREATE TABLE t (a int)` }, /no primary key/);
  });
  test("a primary key, or a unique over NOT NULL columns, is clean", () => {
    clean("SQLPG101", {
      a: table`CREATE TABLE a (id int PRIMARY KEY)`,
      b: table`CREATE TABLE b (k int NOT NULL, UNIQUE (k))`,
    });
  });
});

describe("SQLPG102: foreign key without an index", () => {
  test("flags an unindexed referencing column", () => {
    const u = table`CREATE TABLE u (id bigint PRIMARY KEY)`;
    const o = table`CREATE TABLE o (id bigint PRIMARY KEY, uid bigint REFERENCES ${u} (${u.columns.id}))`;
    flagged("SQLPG102", { u, o }, /foreign key on \(uid\)/);
  });
  test("an index leading with the column covers it", () => {
    const u = table`CREATE TABLE u (id bigint PRIMARY KEY)`;
    const o = table`CREATE TABLE o (id bigint PRIMARY KEY, uid bigint REFERENCES ${u} (${u.columns.id}))`;
    const i = index`CREATE INDEX o_uid_idx ON ${o} (${o.columns.uid})`;
    clean("SQLPG102", { u, o, i });
  });
});

describe("SQLPG103: serial", () => {
  test("flags bigserial", () => flagged("SQLPG103", { t: table`CREATE TABLE t (id bigserial PRIMARY KEY)` }, /identity/));
  test("identity is clean", () => clean("SQLPG103", { t: table`CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY)` }));
});

describe("SQLPG104: timestamp without time zone", () => {
  test("flags timestamp(3)", () => flagged("SQLPG104", { t: table`CREATE TABLE t (at timestamp(3))` }, /timestamptz/));
  test("timestamptz is clean", () => clean("SQLPG104", { t: table`CREATE TABLE t (at timestamptz, b timestamp with time zone)` }));
});

describe("SQLPG105: json", () => {
  test("flags json", () => flagged("SQLPG105", { t: table`CREATE TABLE t (j json)` }, /jsonb/));
  test("jsonb is clean", () => clean("SQLPG105", { t: table`CREATE TABLE t (j jsonb)` }));
});

describe("SQLPG106: char(n)", () => {
  test("flags char(3)", () => flagged("SQLPG106", { t: table`CREATE TABLE t (c char(3))` }, /pads/));
  test("varchar and text are clean", () => clean("SQLPG106", { t: table`CREATE TABLE t (c varchar(3), d text)` }));
});

describe("SQLPG107: money", () => {
  test("flags money", () => flagged("SQLPG107", { t: table`CREATE TABLE t (m money)` }, /lc_monetary/));
  test("numeric is clean", () => clean("SQLPG107", { t: table`CREATE TABLE t (m numeric(12, 2))` }));
});

describe("SQLPG108: habitual varchar limit", () => {
  test("flags varchar(255)", () => flagged("SQLPG108", { t: table`CREATE TABLE t (c varchar(255))` }, /varchar\(255\)/));
  test("a limit that is a rule is clean", () => clean("SQLPG108", { t: table`CREATE TABLE t (c varchar(2), d character varying(37))` }));
});

describe("SQLPG109: duplicate index", () => {
  test("flags an index over a primary key's columns", () => {
    const t = table`CREATE TABLE t (id int PRIMARY KEY, a int)`;
    const i = index`CREATE INDEX t_id_idx ON ${t} (${t.columns.id})`;
    flagged("SQLPG109", { t, i }, /primary key/);
  });
  test("flags two identical indexes", () => {
    const t = table`CREATE TABLE t (id int PRIMARY KEY, a int)`;
    const i = index`CREATE INDEX t_a_1 ON ${t} (${t.columns.a})`;
    const j = index`CREATE INDEX t_a_2 ON ${t} (${t.columns.a})`;
    flagged("SQLPG109", { t, i, j }, /duplicates/);
  });
  test("a partial index on the same column is not a duplicate", () => {
    const t = table`CREATE TABLE t (id int PRIMARY KEY, a int)`;
    const i = index`CREATE INDEX t_a_1 ON ${t} (${t.columns.a})`;
    const j = index`CREATE INDEX t_a_2 ON ${t} (${t.columns.a}) WHERE a > 0`;
    clean("SQLPG109", { t, i, j });
  });
});

describe("SQLPG110: prefix index", () => {
  test("flags an index that is a prefix of another", () => {
    const t = table`CREATE TABLE t (id int PRIMARY KEY, a int, b int)`;
    const i = index`CREATE INDEX t_a ON ${t} (${t.columns.a})`;
    const j = index`CREATE INDEX t_ab ON ${t} (${t.columns.a}, ${t.columns.b})`;
    flagged("SQLPG110", { t, i, j }, /prefix of t_ab/);
  });
  test("a different leading column is clean", () => {
    const t = table`CREATE TABLE t (id int PRIMARY KEY, a int, b int)`;
    const i = index`CREATE INDEX t_b ON ${t} (${t.columns.b})`;
    const j = index`CREATE INDEX t_ab ON ${t} (${t.columns.a}, ${t.columns.b})`;
    clean("SQLPG110", { t, i, j });
  });
});

describe("SQLPG111: materialized view without a unique index", () => {
  test("flags one with none", () => {
    flagged("SQLPG111", { mv: view`CREATE MATERIALIZED VIEW mv AS SELECT 1 AS a` }, /CONCURRENTLY/);
  });
  test("a unique index over columns is clean", () => {
    const mv = view`CREATE MATERIALIZED VIEW mv AS SELECT 1 AS a`;
    const i = index`CREATE UNIQUE INDEX mv_a ON ${mv} (${mv.columns.a})`;
    clean("SQLPG111", { mv, i });
  });
});

describe("SQLPG112: sensitive column without a comment", () => {
  test("flags an email column", () => {
    flagged("SQLPG112", { t: table`CREATE TABLE t (id int PRIMARY KEY, email text)` }, /t\.email/);
  });
  test("a table or column comment is clean", () => {
    clean("SQLPG112", {
      a: table`CREATE TABLE a (email text); COMMENT ON TABLE a IS 'Accounts, emails hashed'`,
      b: table`CREATE TABLE b (email text); COMMENT ON COLUMN b.email IS 'Login address, masked in exports'`,
      c: table`CREATE TABLE c (name text)`,
    });
  });
});

describe("SQLPG113: public schema", () => {
  test("flags an unqualified table when a schema is declared", () => {
    flagged("SQLPG113", { app: schema`CREATE SCHEMA app`, t: table`CREATE TABLE t (id int)` }, /public schema/);
  });
  test("qualified, or no schema declared, is clean", () => {
    const app = schema`CREATE SCHEMA app`;
    clean("SQLPG113", { app, t: table`CREATE TABLE ${app}.t (id int)` });
    clean("SQLPG113", { t: table`CREATE TABLE t (id int)` });
  });
});

describe("SQLPG114: storage parameters", () => {
  test("flags an unknown parameter", () => {
    flagged("SQLPG114", { t: table`CREATE TABLE t (id int) WITH (fillfactr = 70)` }, /not a Postgres 18 storage parameter/);
  });
  test("flags a parameter for another relation kind", () => {
    const t = table`CREATE TABLE t (id int)`;
    const i = index`CREATE INDEX t_id ON ${t} (${t.columns.id}) WITH (fillfactor = 70, buffering = on)`;
    flagged("SQLPG114", { t, i }, /buffering/);
  });
  test("known parameters are clean", () => {
    const t = table`CREATE TABLE t (id int) WITH (fillfactor = 70, autovacuum_enabled = false)`;
    const i = index`CREATE INDEX t_id ON ${t} (${t.columns.id}) WITH (fillfactor = 80)`;
    clean("SQLPG114", { t, i });
  });
});

describe("SQLPG115: features newer than the oldest major", () => {
  test("flags a storage parameter newer than 14, NULLS NOT DISTINCT (15) and a virtual column (18)", () => {
    const v = view`CREATE MATERIALIZED VIEW v WITH (autovacuum_vacuum_max_threshold = 10) AS SELECT 1 AS a`;
    const t = table`CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a + 1) VIRTUAL, UNIQUE NULLS NOT DISTINCT (a))`;
    const msgs = run("SQLPG115", { v, t }).map((d) => d.message).join("\n");
    expect(msgs).toMatch(/autovacuum_vacuum_max_threshold.*needs Postgres 18/);
    expect(msgs).toMatch(/virtual generated column b.*Postgres 18/);
    expect(msgs).toMatch(/NULLS NOT DISTINCT.*Postgres 15/);
  });
  test("flags NOT ENFORCED", () => {
    flagged("SQLPG115", { t: table`CREATE TABLE t (a int, CONSTRAINT pos CHECK (a > 0) NOT ENFORCED)` }, /NOT ENFORCED.*18/);
  });
  test("features every major has are clean", () => {
    clean("SQLPG115", { t: table`CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a + 1) STORED) WITH (fillfactor = 70)` });
  });
});

describe("SQLPG116: removed extension", () => {
  test("flags adminpack, gone after 16", () => {
    flagged("SQLPG116", { e: extension`CREATE EXTENSION adminpack` }, /adminpack.*last in 16/);
  });
  test("a shipped extension is clean", () => clean("SQLPG116", { e: extension`CREATE EXTENSION pg_trgm` }));
});

describe("SQLPG117: view without security_invoker", () => {
  test("flags a plain view", () => {
    flagged("SQLPG117", { v: view`CREATE VIEW v AS SELECT 1 AS a` }, /security_invoker/);
  });
  test("security_invoker = true is clean", () => {
    clean("SQLPG117", { v: view`CREATE VIEW v WITH (security_invoker = true) AS SELECT 1 AS a` });
  });
});

describe("SQLPG118: INHERITS", () => {
  test("flags an inheriting table", () => {
    const p = table`CREATE TABLE p (id int)`;
    flagged("SQLPG118", { p, c: table`CREATE TABLE c (x int) INHERITS (${p})` }, /INHERITS/);
  });
  test("a partition is clean", () => {
    const p = table`CREATE TABLE p (id int) PARTITION BY RANGE (id)`;
    clean("SQLPG118", { p, c: table`CREATE TABLE c PARTITION OF ${p} FOR VALUES FROM (1) TO (10)` });
  });
});
