import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseStatements, type IndexNode, type SequenceNode, type TableNode, type ViewNode } from "./parser";
import { SqlSyntaxError, tokenize, tokenizeText, untokenize } from "./tokens";

const parse = (sql: string) => parseStatements(tokenizeText(sql, 0));
const one = <T>(sql: string) => parse(sql)[0] as T;
const kinds = (sql: string) => tokenizeText(sql, 0).filter((t) => t.kind !== "ws").map((t) => `${t.kind}:${t.text}`);
const fails = (sql: string): SqlSyntaxError => {
  try {
    parse(sql);
  } catch (err) {
    if (err instanceof SqlSyntaxError) return err;
    throw err;
  }
  throw new Error(`parsed: ${sql}`);
};
/** The text an error is located at. */
const at = (sql: string) => {
  const err = fails(sql);
  return sql.slice(err.offset, err.offset + (err.token?.text.length ?? 1));
};

describe("Postgres's lexical rules", () => {
  test("are lossless: tokens give the raw text back, comments and spacing included", () => {
    const parts = ["CREATE TABLE t (\n  a int, -- the key\n  /* outer /* inner */ still */ b ", " DEFAULT $$it's -- not$$\n)"];
    expect(untokenize(tokenize(parts), (i) => "${" + i + "}")).toBe(parts.join("${0}"));
  });

  test("a backslash is ordinary in '...' and escapes only in E'...'", () => {
    expect(kinds(String.raw`'a\'`)).toEqual([String.raw`string:'a\'`]);
    expect(kinds(String.raw`E'a\'b'`)).toEqual([String.raw`string:E'a\'b'`]);
  });

  test("dollar quotes, prefixed strings, parameters and nested comments are one token each", () => {
    expect(kinds("$tag$ a $$ b $tag$ $1 B'101' X'1F' U&'d\\0061t' /* a /* b */ c */")).toEqual([
      "string:$tag$ a $$ b $tag$",
      "param:$1",
      "string:B'101'",
      "string:X'1F'",
      "string:U&'d\\0061t'",
      "comment:/* a /* b */ c */",
    ]);
  });

  test("a double quote makes an identifier; a backtick is an operator character", () => {
    expect(kinds('"My Col" `')).toEqual(['qident:"My Col"', "op:`"]);
  });

  test("numbers never run into names, and an operator does not end in a sign", () => {
    expect(kinds("1e-3 .5 0x1F 1_000 2abc")).toEqual(["number:1e-3", "number:.5", "number:0x1F", "number:1_000", "number:2", "ident:abc"]);
    expect(kinds("a=-30 b<>-1 c@-1")).toEqual(["ident:a", "op:=", "op:-", "number:30", "ident:b", "op:<>", "op:-", "number:1", "ident:c", "op:@-", "number:1"]);
  });
});

describe("CREATE TABLE", () => {
  const node = one<TableNode>(`CREATE UNLOGGED TABLE IF NOT EXISTS App.Orders (
    id        bigint GENERATED ALWAYS AS IDENTITY (START WITH 10) PRIMARY KEY,
    "UserId"  bigint NOT NULL REFERENCES app.users (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    status    text COLLATE "C" NOT NULL DEFAULT 'placed',
    amount    numeric(12, 2) NOT NULL CHECK (amount >= 0),
    total     numeric GENERATED ALWAYS AS (amount * 2) STORED,
    tags      text[] DEFAULT ARRAY['a', 'b'],
    during    tstzrange,
    CONSTRAINT orders_status_ck CHECK (status IN ('placed', 'paid')) NOT VALID,
    UNIQUE NULLS NOT DISTINCT (status, amount) INCLUDE (id) WITH (fillfactor = 90),
    EXCLUDE USING gist (during WITH &&) WHERE (status <> 'cancelled'),
    FOREIGN KEY ("UserId") REFERENCES app.users MATCH FULL ON UPDATE SET NULL ("UserId")
  ) PARTITION BY RANGE (id) WITH (fillfactor = 70, toast.autovacuum_enabled = false) TABLESPACE fast`);

  test("reads names, folding the unquoted ones", () => {
    expect(node.persistence).toBe("unlogged");
    expect(node.ifNotExists).toBe(true);
    expect(node.name.pieces).toEqual(["app", "orders"]);
    expect(node.columns.map((c) => c.name)).toEqual(["id", "UserId", "status", "amount", "total", "tags", "during"]);
  });

  test("reads identity, generated, defaults and column constraints", () => {
    const [id, user, status, amount, total] = node.columns;
    expect(id!.generated).toMatchObject({ kind: "identity", always: true });
    expect(id!.constraints.map((c) => c.kind)).toEqual(["PRIMARY KEY"]);
    expect(user!.constraints[0]).toMatchObject({ kind: "FOREIGN KEY", deferrable: true, initiallyDeferred: true });
    expect(status!.notNull).toBe(true);
    expect(status!.collate).toBeDefined();
    expect(amount!.constraints.map((c) => c.kind)).toEqual(["CHECK"]);
    expect(total!.generated).toMatchObject({ kind: "stored", always: true });
  });

  test("reads every table constraint kind and its attributes", () => {
    expect(node.constraints.map((c) => c.kind)).toEqual(["CHECK", "UNIQUE", "EXCLUDE", "FOREIGN KEY"]);
    expect(node.constraints[0]).toMatchObject({ name: "orders_status_ck", notValid: true });
    expect(node.constraints[1]).toMatchObject({ nullsNotDistinct: true });
    expect(node.constraints[2]).toMatchObject({ using: "gist" });
    expect(node.constraints[3]!.references).toMatchObject({ match: "FULL" });
    expect(node.partitionBy).toBeDefined();
    expect(node.with).toBeDefined();
  });

  test("partitions, typed tables and LIKE parse", () => {
    expect(one<TableNode>("CREATE TABLE p1 PARTITION OF orders FOR VALUES FROM (1) TO (100)").partitionOf?.pieces).toEqual(["orders"]);
    expect(one<TableNode>("CREATE TABLE p2 PARTITION OF orders DEFAULT").partitionBound).toBeDefined();
    expect(one<TableNode>("CREATE TABLE h PARTITION OF orders FOR VALUES WITH (MODULUS 4, REMAINDER 1)").partitionBound).toBeDefined();
    expect(one<TableNode>("CREATE TABLE t OF some_type (a WITH OPTIONS NOT NULL)").columns[0]!.notNull).toBe(true);
    expect(one<TableNode>("CREATE TABLE t (LIKE src INCLUDING ALL EXCLUDING INDEXES, x int)").like).toHaveLength(1);
  });
});

describe("the grammar gaps the spike listed are closed", () => {
  test("a default is a b_expr: a top-level IN, AND or IS NULL fails at that token", () => {
    expect(at("CREATE TABLE t (a int DEFAULT 1 IN (1, 2))")).toBe("IN");
    expect(at("CREATE TABLE t (a bool DEFAULT true AND false)")).toBe("AND");
    expect(at("CREATE TABLE t (a bool DEFAULT 1 IS NULL)")).toBe("IS");
    expect(() => parse("CREATE TABLE t (a bool DEFAULT (1 IN (1, 2)), b int DEFAULT 1 IS DISTINCT FROM 2)")).not.toThrow();
  });

  test("LIKE options and ON COMMIT take only their own words", () => {
    expect(at("CREATE TABLE t (LIKE s INCLUDING EVERYTHING)")).toBe("EVERYTHING");
    expect(at("CREATE TEMP TABLE t (a int) ON COMMIT KEEP ROWS")).toBe("KEEP");
  });

  test("a storage parameter list needs a value after =", () => {
    expect(at("CREATE TABLE t (a int) WITH (fillfactor = )")).toBe(")");
    expect(() => parse("CREATE TABLE t (a int) WITH (fillfactor=-30.1)")).not.toThrow();
  });

  test("a reserved word is never a type, and a range bound is never empty", () => {
    expect(at("CREATE TABLE t (a ARRAY[4])")).toBe("ARRAY");
    expect(at("CREATE TABLE p PARTITION OF t FOR VALUES FROM () TO (1)")).toBe(")");
  });

  test("a misspelt key word after an expression fails at the word", () => {
    expect(at("CREATE TABLE t (a text DEFAULT 'x' CHEK (a <> ''))")).toBe("CHEK");
    expect(at("CREATE TABLE t (a bigint PRIMRY KEY)")).toBe("PRIMRY");
  });

  test("a reserved word as a name needs quotes", () => {
    expect(at("CREATE TABLE foo (with int)")).toBe("with");
    expect(() => parse('CREATE TABLE foo ("with" int)')).not.toThrow();
  });
});

describe("the other statements", () => {
  test("an index: CONCURRENTLY, its elements, and a name that is never qualified", () => {
    const node = one<IndexNode>(
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_email ON ONLY app.users USING btree (lower(email) text_pattern_ops, created_at DESC NULLS LAST) INCLUDE (id) WHERE deleted_at IS NULL",
    );
    expect(node).toMatchObject({ unique: true, concurrently: true, ifNotExists: true, only: true, using: "btree" });
    expect(node.elements.map((e) => e.column)).toEqual([undefined, "created_at"]);
    expect(at("CREATE INDEX app.x ON t (a)")).toBe(".");
    expect(one<IndexNode>("CREATE INDEX ON t (a)").name).toBeUndefined();
  });

  test("views stop their query at WITH CHECK OPTION and WITH NO DATA, not at a CTE", () => {
    const v = one<ViewNode>("CREATE OR REPLACE VIEW v (a, b) WITH (security_barrier) AS WITH x AS (SELECT 1 a, 2 b) SELECT * FROM x WITH LOCAL CHECK OPTION");
    expect(v.columnNames.map((c) => c.name)).toEqual(["a", "b"]);
    expect(v.checkOption).toBeDefined();
    const m = one<ViewNode>("CREATE MATERIALIZED VIEW m AS SELECT 1 WITH NO DATA");
    expect(m).toMatchObject({ materialized: true, withData: false });
  });

  test("a sequence's options, a domain, an enum, a schema and an extension", () => {
    const s = one<SequenceNode>("CREATE SEQUENCE s AS integer INCREMENT BY 2 NO MINVALUE MAXVALUE 100 START WITH 5 CACHE 10 NO CYCLE OWNED BY t.id");
    expect(s.options.map((o) => o.option)).toEqual(["AS", "INCREMENT", "NO MINVALUE", "MAXVALUE", "START", "CACHE", "NO CYCLE", "OWNED BY"]);
    expect(parse("CREATE DOMAIN d AS text CONSTRAINT c CHECK (VALUE <> '') NOT VALID")[0]!.statement).toBe("domain");
    expect(parse("CREATE TYPE mood AS ENUM ('sad', 'ok')")[0]!.statement).toBe("enum");
    expect(at("CREATE TYPE mood AS (a int)")).toBe("(");
    expect(parse("CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION owner")[0]!.statement).toBe("schema");
    expect(parse("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public VERSION '1.6' CASCADE")[0]!.statement).toBe("extension");
  });

  test("COMMENT ON statements follow a CREATE in one template", () => {
    const nodes = parse("CREATE TABLE t (a int); COMMENT ON TABLE t IS 'x'; COMMENT ON COLUMN t.a IS NULL;");
    expect(nodes.map((n) => n.statement)).toEqual(["table", "comment", "comment"]);
  });
});

describe("Postgres's own regression SQL (REL_18_6)", () => {
  const corpus = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "postgres-regress-corpus.json"), "utf-8")) as {
    accepted: Record<string, string[]>;
    rejected: string[];
  };

  test("every committed statement of the declared subset parses", () => {
    const failed: string[] = [];
    let n = 0;
    for (const sqls of Object.values(corpus.accepted)) {
      for (const sql of sqls) {
        n++;
        try {
          parse(sql);
        } catch (err) {
          failed.push(`${(err as Error).message}: ${sql.slice(0, 120)}`);
        }
      }
    }
    expect(failed).toEqual([]);
    expect(n).toBe(408);
  });

  test("every statement the tests write as a syntax error is rejected", () => {
    const accepted = corpus.rejected.filter((sql) => {
      try {
        parse(sql);
        return true;
      } catch (err) {
        if (err instanceof SqlSyntaxError) return false;
        throw err;
      }
    });
    expect(accepted).toEqual([]);
    expect(corpus.rejected.length).toBe(27);
  });
});
