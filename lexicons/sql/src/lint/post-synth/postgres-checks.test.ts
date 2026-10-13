import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlSerializer } from "../../serializer";
import { table as chTable } from "../../clickhouse/entities";
import { domain, extension, func, grant, index, role, schema, sequence, table, type as pgType, view } from "../../postgres/entities";
import { sqlAuditCatalog } from "../audit-catalog";
import { postSynthChecks } from "./index";

type Entities = Record<string, unknown>;

function run(id: string, entities: Entities, major?: number) {
  const check = postSynthChecks.find((c: PostSynthCheck) => c.id === id)!;
  const config = major === undefined ? undefined : { sql: { postgresMajor: major } };
  const out = sqlSerializer.serialize(new Map(Object.entries(entities)) as never, undefined, { config }) as SerializerResult;
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
  test("the message names the target major", () => {
    expect(run("SQLPG114", { t: table`CREATE TABLE t (id int) WITH (fillfactr = 70)` }, 14)[0]!.message).toMatch(/not a Postgres 14 storage parameter/);
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

describe("SQLPG115: features newer than the target major", () => {
  test("flags a storage parameter newer than 14, NULLS NOT DISTINCT (15) and a virtual column (18)", () => {
    const v = view`CREATE MATERIALIZED VIEW v WITH (autovacuum_vacuum_max_threshold = 10) AS SELECT 1 AS a`;
    const t = table`CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a + 1) VIRTUAL, UNIQUE NULLS NOT DISTINCT (a))`;
    const msgs = run("SQLPG115", { v, t }, 14).map((d) => d.message).join("\n");
    expect(msgs).toMatch(/autovacuum_vacuum_max_threshold.*needs Postgres 18/);
    expect(msgs).toMatch(/virtual generated column b.*Postgres 18/);
    expect(msgs).toMatch(/NULLS NOT DISTINCT.*Postgres 15/);
  });
  test("flags NOT ENFORCED", () => {
    const t = table`CREATE TABLE t (a int, CONSTRAINT pos CHECK (a > 0) NOT ENFORCED)`;
    expect(run("SQLPG115", { t }, 14)[0]!.message).toMatch(/NOT ENFORCED.*Postgres 18; Postgres 14 refuses/);
  });
  test("a project targeting 18 (or with no target) is not flagged for 18 features", () => {
    const v = view`CREATE MATERIALIZED VIEW v WITH (autovacuum_vacuum_max_threshold = 10) AS SELECT 1 AS a`;
    const t = table`CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a + 1) VIRTUAL, UNIQUE NULLS NOT DISTINCT (a), CONSTRAINT pos CHECK (a > 0) NOT ENFORCED)`;
    expect(run("SQLPG115", { v, t }, 18)).toEqual([]);
    expect(run("SQLPG115", { v, t })).toEqual([]);
  });
  test("at 16 only the 17 and 18 features are flagged, not NULLS NOT DISTINCT (15)", () => {
    const t = table`CREATE TABLE t (a int, UNIQUE NULLS NOT DISTINCT (a), CONSTRAINT pos CHECK (a > 0) NOT ENFORCED)`;
    const msgs = run("SQLPG115", { t }, 16).map((d) => d.message).join("\n");
    expect(msgs).toMatch(/NOT ENFORCED/);
    expect(msgs).not.toMatch(/NULLS NOT DISTINCT/);
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
  test("an extension dropped after 16 is fine at 14 and 16, flagged at 17 and 18", () => {
    const e = extension`CREATE EXTENSION adminpack`;
    expect(run("SQLPG116", { e }, 14)).toEqual([]);
    expect(run("SQLPG116", { e }, 16)).toEqual([]);
    expect(run("SQLPG116", { e }, 17)[0]!.message).toMatch(/Postgres 17 does not ship/);
    expect(run("SQLPG116", { e }, 18)[0]!.message).toMatch(/Postgres 18 does not ship/);
  });
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

// ── Catalog names (chant #3750) ─────────────────────────────────────────

/** Every diagnostic of the catalog-name rules over a set of entities, at one major. */
const CATALOG_RULES = ["SQLPG119", "SQLPG120", "SQLPG121", "SQLPG122", "SQLPG123", "SQLPG124", "SQLPG125", "SQLPG126"];
const allCatalog = (entities: Entities, major?: number) => CATALOG_RULES.flatMap((id) => run(id, entities, major));
const MAJORS = [14, 15, 16, 17, 18];

describe("catalog names: correct declarations stay clean at every major", () => {
  const app = schema`CREATE SCHEMA app`;
  const mood = pgType`CREATE TYPE ${app}.mood AS ENUM ('ok', 'sad')`;
  const pos = domain`CREATE DOMAIN ${app}.pos AS numeric(12,2) CHECK (VALUE > 0)`;
  const label = domain`CREATE DOMAIN ${app}.label AS text DEFAULT lower('x') CHECK (length(VALUE) < 10)`;
  const customers = table`CREATE TABLE ${app}.customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL)`;
  const spellings = table`CREATE TABLE ${app}.spellings (
    a int, b integer, c int4, d bigint, e smallint, f int2, g int8,
    h smallserial, i serial, j bigserial, k serial8,
    l varchar(255), m character varying, n character varying(10), o text[], p int[][], q int[3], r int ARRAY,
    s timestamptz, t timestamp(3) with time zone, u timestamp without time zone, v time with time zone, w time(3) with time zone, x timetz,
    y interval, z interval(6), aa interval day to second(3), ab interval year to month,
    ac numeric, ad numeric(12,2), ae decimal(5), af dec(4,1), ag double precision, ah float, ai float(24), aj float(53), ak real, al float8,
    am bit varying(8), an bit(3), ao varbit, ap jsonb, aq json, ar uuid, as_ inet, at cidr, au tsvector, av bytea, aw bool, ax boolean,
    ay char, az char(2), ba character(3), bb "char", bc date, bd money, be macaddr, bf int4range, bg nchar(2), bh national character varying(5),
    bi ${mood}, bj app.mood, bk ${pos}, bl app.label, bm billing.money, bn pg_catalog.int4, bo ${customers}, bp _int4
  )`;
  const identities = table`CREATE TABLE ${app}.ids (
    a smallint GENERATED ALWAYS AS IDENTITY, b integer GENERATED BY DEFAULT AS IDENTITY, c bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cid integer REFERENCES ${customers} (id), cid2 bigint REFERENCES ${customers},
    at timestamptz DEFAULT now(), u uuid DEFAULT gen_random_uuid(), n numeric DEFAULT coalesce(nullif(1, 2), greatest(1, 2), least(3, 4)),
    s text DEFAULT substring('abc' FROM 1 FOR 2), p int DEFAULT position('b' IN 'abc'), tr text DEFAULT trim(both ' ' FROM ' x '),
    ov text DEFAULT overlay('abc' PLACING 'x' FROM 2 FOR 1), ex numeric DEFAULT extract(year FROM now()), ca bigint DEFAULT CAST('1' AS bigint),
    cs numeric DEFAULT '1'::numeric(10,2), ct varchar(3) DEFAULT CAST('a' AS varchar(3)), cu timestamptz DEFAULT current_timestamp,
    cl timestamp DEFAULT localtimestamp(3), q text DEFAULT billing.make_code(), r int DEFAULT int4('3'), arr int[] DEFAULT ARRAY[1, 2],
    g bigint GENERATED ALWAYS AS (c * 2) STORED,
    CHECK (a > 0 AND EXISTS_LIKE_NAME IS NULL OR lower(s) IN ('a', 'b')),
    CONSTRAINT k UNIQUE (a, b) INCLUDE (n)
  )`;
  const t = table`CREATE TABLE ${app}.docs (id bigint PRIMARY KEY, body text, doc jsonb, tags text[], at timestamptz, r int4range, loc point)`;
  const idx = [
    index`CREATE INDEX d_body ON ${t} (${t.columns.body} text_pattern_ops)`,
    index`CREATE INDEX d_lower ON ${t} ((lower(body)) text_pattern_ops DESC NULLS LAST) INCLUDE (at)`,
    index`CREATE INDEX d_doc ON ${t} USING gin (doc jsonb_path_ops)`,
    index`CREATE INDEX d_doc2 ON ${t} USING gin (doc)`,
    index`CREATE INDEX d_tags ON ${t} USING gin (tags array_ops)`,
    index`CREATE INDEX d_r ON ${t} USING gist (r)`,
    index`CREATE INDEX d_loc ON ${t} USING spgist (loc)`,
    index`CREATE INDEX d_at ON ${t} USING brin (at)`,
    index`CREATE INDEX d_id ON ${t} USING hash (id)`,
    index`CREATE INDEX d_fts ON ${t} USING gin (to_tsvector('english', body))`,
    index`CREATE UNIQUE INDEX d_c ON ${t} (body COLLATE "C" ASC)`,
  ];
  const r = role`CREATE ROLE reader NOLOGIN`;
  const g = grant`GRANT SELECT (id, body), UPDATE (at) ON ${t} TO ${r}`;
  const seq = sequence`CREATE SEQUENCE ${app}.s AS integer`;
  const fn = func`CREATE FUNCTION ${app}.slug(x text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ select lower(x) $$`;
  const uses = table`CREATE TABLE ${app}.uses (id bigint PRIMARY KEY, name text, slug text DEFAULT ${fn}('a'), s2 text GENERATED ALWAYS AS (slug(name)) STORED)`;
  const entities: Entities = { app, mood, pos, label, customers, spellings, identities, t, r, g, seq, fn, uses, ...Object.fromEntries(idx.map((x, n) => [`i${n}`, x])) };
  for (const major of MAJORS) {
    test(`at Postgres ${major}`, () => expect(allCatalog(entities, major)).toEqual([]));
  }
  test("extension types, functions and operator classes, with the extension declared", () => {
    const ext = [extension`CREATE EXTENSION citext`, extension`CREATE EXTENSION postgis`, extension`CREATE EXTENSION pg_trgm`, extension`CREATE EXTENSION "uuid-ossp"`];
    const u = table`CREATE TABLE u (id uuid DEFAULT uuid_generate_v4() PRIMARY KEY, email citext, at geometry(Point, 4326), name text CHECK (similarity(name, 'x') >= 0 AND ST_IsValid(at)))`;
    const i = index`CREATE INDEX u_name ON ${u} USING gin (name gin_trgm_ops)`;
    const j = index`CREATE INDEX u_at ON ${u} USING gist (at)`;
    expect(allCatalog({ ...Object.fromEntries(ext.map((e, n) => [`e${n}`, e])), u, i, j })).toEqual([]);
  });
  test("a table that inherits, or is a partition of, a declared table reads the parent's columns", () => {
    const parent = table`CREATE TABLE p (id bigint NOT NULL, at date NOT NULL) PARTITION BY RANGE (at)`;
    const part = table`CREATE TABLE p1 PARTITION OF ${parent} (PRIMARY KEY (id, at)) FOR VALUES FROM ('2020-01-01') TO ('2021-01-01')`;
    const i = index`CREATE INDEX p1_at ON ${part} (at)`;
    expect(allCatalog({ parent, part, i })).toEqual([]);
  });
});

describe("SQLPG119: unknown type", () => {
  const app = schema`CREATE SCHEMA app`;
  test("numerik(12,2)", () => flagged("SQLPG119", { app, t: table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, amount numerik(12,2))` }, /column amount has type numerik, which Postgres 18 does not have/));
  test("an array of intt", () => flagged("SQLPG119", { app, t: table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, tags text[], bad intt[])` }, /column bad has array element type intt/));
  test("a sequence AS numerik", () => flagged("SQLPG119", { app, s: sequence`CREATE SEQUENCE ${app}.s AS numerik` }, /sequence of type numerik/));
  test("a domain over a typo", () => flagged("SQLPG119", { app, d: domain`CREATE DOMAIN ${app}.d AS textt` }, /domain over type textt/));
  test("app.mood when the project declares app and no mood", () => {
    flagged("SQLPG119", { app, t: table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, status app.mood)` }, /type app\.mood/);
  });
  test("a declared enum, by ${} or by name, is clean", () => {
    const mood = pgType`CREATE TYPE ${app}.mood AS ENUM ('ok')`;
    clean("SQLPG119", { app, mood, t: table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, a ${mood}, b app.mood, c mood)` });
  });
  test("a type in an undeclared schema is left alone", () => clean("SQLPG119", { t: table`CREATE TABLE t (a billing.money, b pg_catalog.int8)` }));
  test("with an extension declared, an unknown name is a warning", () => {
    const d = run("SQLPG119", { e: extension`CREATE EXTENSION hstore`, t: table`CREATE TABLE t (a widget)` });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "warning" });
  });
  test("an extension type without its extension is an error naming it", () => {
    flagged("SQLPG119", { t: table`CREATE TABLE t (email citext)` }, /citext extension, which the project does not declare/);
  });
  test("serial is a column spelling, not a domain base", () => flagged("SQLPG119", { d: domain`CREATE DOMAIN d AS serial` }, /serial/));
});

describe("SQLPG120: type modifiers", () => {
  test("bigint(8)", () => flagged("SQLPG120", { t: table`CREATE TABLE t (id bigint(8) PRIMARY KEY)` }, /bigint takes no type modifier/));
  test("numeric(2000,2)", () => flagged("SQLPG120", { t: table`CREATE TABLE t (a numeric(2000,2))` }, /precision 2000 is outside 1 to 1000/));
  test("varchar(0)", () => flagged("SQLPG120", { t: table`CREATE TABLE t (code varchar(0))` }, /length 0 is outside 1 to 10485760/));
  test("timestamp(7), interval(9), bit(0), float(54)", () => {
    const msgs = run("SQLPG120", { t: table`CREATE TABLE t (a timestamp(7), b interval(9), c bit(0), d float(54), e numeric(1,2,3))` }).map((d) => d.message).join("\n");
    expect(msgs).toMatch(/precision 7 is outside 0 to 6/);
    expect(msgs).toMatch(/column b .*precision 9/);
    expect(msgs).toMatch(/length 0 is outside 1/);
    expect(msgs).toMatch(/float precision 54/);
    expect(msgs).toMatch(/at most 2 modifiers/);
  });
  test("a negative numeric scale is fine at 15 and refused at 14", () => {
    const t = table`CREATE TABLE t (a numeric(5,-2))`;
    expect(run("SQLPG120", { t }, 15)).toEqual([]);
    expect(run("SQLPG120", { t }, 14)[0]!.message).toMatch(/scale -2 is outside 0 to 5 at Postgres 14/);
  });
  test("an extension type's modifiers are its own", () => clean("SQLPG120", { e: extension`CREATE EXTENSION postgis`, t: table`CREATE TABLE t (g geometry(Point, 4326))` }));
});

describe("SQLPG121: identity type", () => {
  test("text identity", () => flagged("SQLPG121", { t: table`CREATE TABLE t (id text GENERATED ALWAYS AS IDENTITY PRIMARY KEY)` }, /identity column of type text/));
  test("numeric identity", () => flagged("SQLPG121", { t: table`CREATE TABLE t (id numeric GENERATED BY DEFAULT AS IDENTITY)` }, /must be smallint, integer or bigint/));
});

describe("SQLPG122: duplicates in a table or enum", () => {
  test("(id bigint, id int)", () => flagged("SQLPG122", { t: table`CREATE TABLE t (id bigint PRIMARY KEY, id int)` }, /declares the column id more than once/));
  test("ENUM ('a', 'a')", () => flagged("SQLPG122", { m: pgType`CREATE TYPE m AS ENUM ('a', 'a')` }, /label 'a' more than once/));
  test("labels differing in case are distinct", () => clean("SQLPG122", { m: pgType`CREATE TYPE m AS ENUM ('a', 'A')` }));
});

describe("SQLPG123: column lists", () => {
  const app = schema`CREATE SCHEMA app`;
  const orders = table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, email text NOT NULL, total numeric NOT NULL)`;
  test("PRIMARY KEY (idd)", () => flagged("SQLPG123", { t: table`CREATE TABLE t (id bigint, CONSTRAINT p PRIMARY KEY (idd))` }, /PRIMARY KEY names the column idd, which t does not declare/));
  test("UNIQUE (emial)", () => flagged("SQLPG123", { t: table`CREATE TABLE t (id bigint PRIMARY KEY, email text, UNIQUE (emial))` }, /UNIQUE names the column emial/));
  test("a foreign key's own columns", () => {
    flagged("SQLPG123", { orders, t: table`CREATE TABLE t (id bigint PRIMARY KEY, FOREIGN KEY (order_idd) REFERENCES ${orders} (id))` }, /FOREIGN KEY to app.orders names the column order_idd/);
  });
  test("an index on a declared table", () => flagged("SQLPG123", { app, orders, i: index`CREATE INDEX orders_x ON ${orders} (emial)` }, /index on app.orders names the column emial/));
  test("an index INCLUDE", () => flagged("SQLPG123", { app, orders, i: index`CREATE INDEX orders_x ON ${orders} (email) INCLUDE (totl)` }, /INCLUDE names the column totl/));
  test("GRANT SELECT (totl) ON ${orders}", () => {
    const r = role`CREATE ROLE app_reader NOLOGIN`;
    flagged("SQLPG123", { app, orders, r, g: grant`GRANT SELECT (totl) ON ${orders} TO ${r}` }, /GRANT SELECT on app.orders names the column totl/);
  });
  test("index expressions, CHECKs, plain-text tables and LIKE are left to the server", () => {
    clean("SQLPG123", {
      app,
      orders,
      i: index`CREATE INDEX orders_l ON ${orders} ((lower(emial)))`,
      j: index`CREATE INDEX x ON app.nope (id)`,
      c: table`CREATE TABLE c (id bigint PRIMARY KEY, CHECK (amout > 0))`,
      l: table`CREATE TABLE l (LIKE app.orders, PRIMARY KEY (id))`,
    });
  });
});

describe("SQLPG124: foreign key targets", () => {
  const app = schema`CREATE SCHEMA app`;
  const customers = table`CREATE TABLE ${app}.customers (id bigint PRIMARY KEY, code text UNIQUE)`;
  test("REFERENCES ${customers} (idd)", () => {
    flagged("SQLPG124", { app, customers, o: table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, customer_id bigint REFERENCES ${customers} (idd))` }, /to app.customers \(idd\), which app.customers does not declare/);
  });
  test("text to bigint", () => {
    flagged("SQLPG124", { app, customers, o: table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, customer_id text REFERENCES ${customers} (id))` }, /from customer_id \(text\) to app.customers \(id\) \(bigint\); the types do not compare/);
  });
  test("the primary key when no columns are named", () => {
    flagged("SQLPG124", { app, customers, o: table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, customer_id uuid REFERENCES ${customers})` }, /types do not compare/);
  });
  test("integer to bigint, varchar to text, and a plain-text target are clean", () => {
    clean("SQLPG124", {
      app,
      customers,
      o: table`CREATE TABLE ${app}.orders (id bigint PRIMARY KEY, a integer REFERENCES ${customers} (id), b varchar(10) REFERENCES ${customers} (code), c text REFERENCES app.elsewhere (id))`,
    });
  });
});

describe("SQLPG125: access methods and operator classes", () => {
  const t = table`CREATE TABLE t (id bigint PRIMARY KEY, email text, total numeric, doc jsonb)`;
  test("USING btreee", () => flagged("SQLPG125", { t, i: index`CREATE INDEX t_x ON ${t} USING btreee (email)` }, /access method btreee, which Postgres 18 does not have/));
  test("numeric_opz", () => flagged("SQLPG125", { t, i: index`CREATE INDEX t_x ON ${t} (total numeric_opz)` }, /operator class numeric_opz, which Postgres 18 does not have for btree/));
  test("an operator class of another method", () => flagged("SQLPG125", { t, i: index`CREATE INDEX t_x ON ${t} (doc jsonb_path_ops)` }, /jsonb_path_ops, which is for gin, not btree/));
  test("gin_trgm_ops without pg_trgm is an error naming it; with it, clean", () => {
    const i = index`CREATE INDEX t_x ON ${t} USING gin (email gin_trgm_ops)`;
    flagged("SQLPG125", { t, i }, /pg_trgm extension, which the project does not declare/);
    clean("SQLPG125", { t, i, e: extension`CREATE EXTENSION pg_trgm` });
  });
  test("an operator class in an undeclared schema is left alone", () => clean("SQLPG125", { t, i: index`CREATE INDEX t_x ON ${t} (email ext.my_ops)` }));
});

describe("SQLPG126: functions", () => {
  test("DEFAULT noww()", () => flagged("SQLPG126", { t: table`CREATE TABLE t (id bigint PRIMARY KEY, at timestamptz DEFAULT noww())` }, /column at's DEFAULT calls noww\(\), which Postgres 18 does not have/));
  test("a CHECK, a generated column, an index expression", () => {
    const t = table`CREATE TABLE t (id bigint PRIMARY KEY, a text CHECK (lenght(a) > 0), b text GENERATED ALWAYS AS (lowr(a)) STORED)`;
    const msgs = run("SQLPG126", { t, i: index`CREATE INDEX t_u ON ${t} ((uper(a)))` }).map((d) => d.message).join("\n");
    expect(msgs).toMatch(/a CHECK calls lenght/);
    expect(msgs).toMatch(/generated column b calls lowr/);
    expect(msgs).toMatch(/index expression calls uper/);
  });
  test("a function newer than the target major", () => {
    const t = table`CREATE TABLE t (id uuid DEFAULT uuidv7())`;
    expect(run("SQLPG126", { t }, 17)[0]!.message).toMatch(/uuidv7\(\), which needs Postgres 18; Postgres 17 does not have it/);
    expect(run("SQLPG126", { t }, 18)).toEqual([]);
  });
  test("with an extension declared, an unknown name is a warning", () => {
    const d = run("SQLPG126", { e: extension`CREATE EXTENSION hstore`, t: table`CREATE TABLE t (a text DEFAULT make_widget())` });
    expect(d[0]).toMatchObject({ severity: "warning" });
  });
  test("names in strings and quoted identifiers' casts are not calls", () => {
    clean("SQLPG126", { t: table`CREATE TABLE t (a text DEFAULT 'noww()', b text CHECK (b <> 'x(y)'))` });
  });
});
