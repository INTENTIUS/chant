/**
 * A stand-in for a ClickHouse server that an apply can write to, for the
 * applier's tests (#3208). It keeps a set of objects, answers the catalog
 * reads observation makes, and takes the writes an apply sends: a `CREATE`
 * adds an object with the statement as its definition, a `DROP` removes one,
 * `MODIFY COMMENT` sets a comment. Every other `ALTER` is recorded and
 * answered, and does not change the definition. Not a SQL engine.
 */

import { startHttpStub } from "../../core/testing/http-stub";
import { canonicalObject } from "../plan/normalize";

export interface StoredObject {
  database?: string;
  name: string;
  engine: string;
  statement: string;
  comment?: string;
}

export interface WritableServer {
  url: string;
  objects: StoredObject[];
  /** Every statement that is not a read, in order. */
  writes: string[];
  /** The targets of every DROP. */
  deletes: string[];
  /** Unfinished mutations `system.mutations` reports. */
  mutations: Array<{ database: string; table: string; mutation_id: string; latest_fail_reason?: string }>;
  /** Refuse statements matching this, with the server's error. */
  refuse?: RegExp;
  close(): Promise<void>;
}

const row = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const unquote = (s: string) => s.replace(/^`|`$/g, "").replace(/``/g, "`");
const literal = (s: string) => s.slice(1, -1).replace(/\\(.)/g, "$1");

function engineOf(statement: string): string {
  const c = canonicalObject(statement);
  if (c.kind === "view") return "View";
  if (c.kind === "materializedView") return "MaterializedView";
  return c.engineName ?? (c.kind === "database" ? "Atomic" : "MergeTree");
}

export async function writableClickHouse(initial: StoredObject[] = []): Promise<WritableServer> {
  const state: WritableServer = {
    url: "",
    objects: initial.map((o) => ({ ...o })),
    writes: [],
    deletes: [],
    mutations: [],
    close: async () => undefined,
  };
  const find = (db: string | undefined, name: string) => state.objects.find((o) => o.database === db && o.name === name);

  const answer = (body: string): { status: number; text: string } => {
    const sql = body.trim();
    if (/^SELECT version\(\)/.test(sql)) return { status: 200, text: row({ v: "26.8.15.10" }) };
    if (/FROM system\.databases/.test(sql)) {
      return {
        status: 200,
        text: state.objects
          .filter((o) => o.database === undefined)
          .map((o) => row({ name: o.name, engine: o.engine, uuid: "00000000-0000-0000-0000-000000000000", comment: o.comment ?? "" }))
          .join(""),
      };
    }
    if (/^SELECT count\(\) AS n FROM system\.tables WHERE database = '(.*)'$/.test(sql)) {
      const db = literal(/'(.*)'$/.exec(sql)![0]);
      return { status: 200, text: row({ n: state.objects.filter((o) => o.database === db).length }) };
    }
    if (/FROM system\.tables/.test(sql)) {
      return {
        status: 200,
        text: state.objects
          .filter((o) => o.database !== undefined)
          .map((o) => row({ database: o.database, name: o.name, engine: o.engine, uuid: "00000000-0000-0000-0000-000000000000", comment: o.comment ?? "" }))
          .join(""),
      };
    }
    if (/FROM system\.mutations/.test(sql)) {
      const m = /database = '([^']*)' AND table = '([^']*)'/.exec(sql);
      return {
        status: 200,
        text: state.mutations
          .filter((x) => m && x.database === m[1] && x.table === m[2])
          .map((x) => row({ mutation_id: x.mutation_id, command: "(MODIFY COLUMN)", latest_fail_reason: x.latest_fail_reason ?? "" }))
          .join(""),
      };
    }
    const show = /^SHOW CREATE (DATABASE|TABLE) (`(?:[^`]|``)*`)(?:\.(`(?:[^`]|``)*`))?$/.exec(sql);
    if (show) {
      const [db, name] = show[3] ? [unquote(show[2]!), unquote(show[3])] : [undefined, unquote(show[2]!)];
      const o = find(db, name);
      return o ? { status: 200, text: row({ statement: o.statement }) } : { status: 404, text: `Code: 60. DB::Exception: Table ${name} does not exist. (UNKNOWN_TABLE)` };
    }
    if (/^SELECT formatQuerySingleLine/.test(sql)) return { status: 400, text: "fake ClickHouse does not format" };

    state.writes.push(sql);
    if (state.refuse?.test(sql)) return { status: 500, text: `Code: 36. DB::Exception: refused by the test. (BAD_ARGUMENTS)` };
    if (/^(?:--[^\n]*\n\s*)*CREATE\b/i.test(sql)) {
      const c = canonicalObject(sql);
      const existing = find(c.kind === "database" ? undefined : c.database, c.name);
      if (existing && !/^(?:--[^\n]*\n\s*)*CREATE OR REPLACE/i.test(sql)) return { status: 500, text: `Code: 57. DB::Exception: Table ${c.name} already exists. (TABLE_ALREADY_EXISTS)` };
      if (existing) state.objects.splice(state.objects.indexOf(existing), 1);
      state.objects.push({
        ...(c.kind === "database" ? {} : { database: c.database }),
        name: c.name,
        engine: engineOf(sql),
        statement: sql.replace(/^CREATE OR REPLACE /i, "CREATE "),
        ...(c.comment !== undefined ? { comment: c.comment } : {}),
      });
      return { status: 200, text: "" };
    }
    const drop = /^DROP (DATABASE|TABLE|VIEW) (`(?:[^`]|``)*`)(?:\.(`(?:[^`]|``)*`))?/.exec(sql);
    if (drop) {
      const [db, name] = drop[3] ? [unquote(drop[2]!), unquote(drop[3])] : [undefined, unquote(drop[2]!)];
      state.deletes.push(db ? `${db}.${name}` : name);
      const o = find(db, name);
      if (o) state.objects.splice(state.objects.indexOf(o), 1);
      return { status: 200, text: "" };
    }
    const comment = /^ALTER (DATABASE|TABLE) (`(?:[^`]|``)*`)(?:\.(`(?:[^`]|``)*`))? MODIFY COMMENT ('(?:[^'\\]|\\.)*')$/.exec(sql);
    if (comment) {
      const [db, name] = comment[3] ? [unquote(comment[2]!), unquote(comment[3])] : [undefined, unquote(comment[2]!)];
      const o = find(db, name);
      if (o) {
        o.comment = literal(comment[4]!);
        o.statement = `${o.statement.replace(/\s+COMMENT '(?:[^'\\]|\\.)*'\s*$/, "")}\nCOMMENT ${comment[4]}`;
      }
      return { status: 200, text: "" };
    }
    return { status: 200, text: "" };
  };

  const stub = await startHttpStub((body) => answer(body));
  state.url = stub.url;
  state.close = stub.close;
  return state;
}
