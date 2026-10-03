/**
 * A fake Postgres server for the applier's unit tests (#3280): a client that
 * keeps the objects it was sent `CREATE` for, their comments set by
 * `COMMENT ON`, and drops them on `DROP`, with transactions that roll back;
 * and a catalog reader over what it keeps, standing in for
 * `../live/catalog.ts`. What it was sent is recorded, so a test asserts on
 * the transport.
 *
 * It parses statements with the dialect's own parser, so what it stores reads
 * back as the declaration it came from. It does not model locks, column
 * changes or dependencies: a test that needs those runs against the pinned
 * server (`../../op/activities/postgres-apply.e2e.test.ts`).
 */

import type { PostgresClient } from "../live/client";
import { PostgresQueryError } from "../live/client";
import type { LivePgObject } from "../live/catalog";
import { stripMarker } from "../../core/ownership";
import { tokenizeText } from "../tokens";
import { parseStatements, type CommentNode, type NameNode } from "../parser";
import { POSTGRES_ENTITY_TYPES, type PostgresEntityType } from "../entity-types";
import { quoteIdent } from "../keywords";

/** One object the fake holds. */
export interface StoredPgObject {
  type: PostgresEntityType;
  schema?: string;
  name: string;
  /** The CREATE statement, as sent. */
  create: string;
  /** The comment, chant's trailer included. */
  comment?: string;
  /** Another tool keeps it (an ORM's revision table). */
  foreign?: string;
}

export interface WritablePostgres {
  client: PostgresClient;
  /** Reads what the fake holds, as the catalog reader would print it. */
  readLive: () => Promise<LivePgObject[]>;
  objects: StoredPgObject[];
  /** Every statement sent that is not session or transaction control. */
  writes: string[];
  /** The DROP statements sent. */
  deletes: string[];
  /** Transaction control as sent: BEGIN, COMMIT, ROLLBACK. */
  control: string[];
  /** A statement matching this fails with `refuseCode`. */
  refuse?: RegExp;
  refuseCode?: string;
}

const KIND_WORD: Record<string, string> = {
  [POSTGRES_ENTITY_TYPES.schema]: "SCHEMA",
  [POSTGRES_ENTITY_TYPES.table]: "TABLE",
  [POSTGRES_ENTITY_TYPES.index]: "INDEX",
  [POSTGRES_ENTITY_TYPES.view]: "VIEW",
  [POSTGRES_ENTITY_TYPES.materializedView]: "MATERIALIZED VIEW",
  [POSTGRES_ENTITY_TYPES.sequence]: "SEQUENCE",
  [POSTGRES_ENTITY_TYPES.enum]: "TYPE",
  [POSTGRES_ENTITY_TYPES.domain]: "DOMAIN",
  [POSTGRES_ENTITY_TYPES.extension]: "EXTENSION",
};

const flat = (type: string) => type === POSTGRES_ENTITY_TYPES.schema || type === POSTGRES_ENTITY_TYPES.extension;
const qname = (o: { type: string; schema?: string; name: string }) => (flat(o.type) || !o.schema ? quoteIdent(o.name) : `${quoteIdent(o.schema)}.${quoteIdent(o.name)}`);
const split = (n: NameNode, defaultSchema = "public"): { schema: string; name: string } =>
  n.pieces.length > 1 ? { schema: n.pieces[0]!, name: n.pieces[1]! } : { schema: defaultSchema, name: n.pieces[0]! };
const unquote = (s: string) => s.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");

export function writablePostgres(seed: StoredPgObject[] = []): WritablePostgres {
  let objects = seed.map((o) => ({ ...o }));
  let snapshot: StoredPgObject[] | undefined;
  const server: WritablePostgres = {
    objects,
    writes: [],
    deletes: [],
    control: [],
    readLive: async () =>
      server.objects.map((o, i) => {
        const own = o.comment !== undefined ? stripMarker(o.comment) : "";
        return {
          type: o.type,
          ...(flat(o.type) ? {} : { schema: o.schema }),
          name: o.name,
          oid: String(16384 + i),
          ...(o.comment !== undefined ? { comment: o.comment } : {}),
          ...(o.foreign ? { foreign: o.foreign } : {}),
          statement: [o.create, ...(own ? [`COMMENT ON ${KIND_WORD[o.type]} ${qname(o)} IS '${own.replace(/'/g, "''")}'`] : [])].join(";\n"),
        };
      }),
    client: {
      async query<T>(sql: string): Promise<T[]> {
        const s = sql.trim();
        if (/^BEGIN$/i.test(s)) {
          server.control.push("BEGIN");
          snapshot = server.objects.map((o) => ({ ...o }));
          return [];
        }
        if (/^COMMIT$/i.test(s)) {
          server.control.push("COMMIT");
          snapshot = undefined;
          return [];
        }
        if (/^ROLLBACK$/i.test(s)) {
          server.control.push("ROLLBACK");
          if (snapshot) server.objects = objects = snapshot;
          snapshot = undefined;
          return [];
        }
        if (/^(SET|SELECT|RESET)\b/i.test(s)) return [];
        if (server.refuse?.test(s)) throw new PostgresQueryError(`refused: ${s.split("\n")[0]}`, server.refuseCode ?? "XX000");
        server.writes.push(s);
        const drop = /^DROP\s+(MATERIALIZED VIEW|INDEX(?:\s+CONCURRENTLY)?|TABLE|VIEW|SEQUENCE|TYPE|DOMAIN|EXTENSION|SCHEMA)\s+(.+)$/i.exec(s);
        if (drop) {
          server.deletes.push(s);
          const word = drop[1]!.toUpperCase().replace(/\s+CONCURRENTLY$/, "");
          const at = server.objects.findIndex((o) => KIND_WORD[o.type] === word && qname(o) === drop[2]!.trim());
          if (at >= 0) server.objects.splice(at, 1);
          return [];
        }
        let node;
        try {
          node = parseStatements(tokenizeText(s, 0))[0];
        } catch {
          return []; // ALTER and the rest: recorded, not modelled
        }
        if (!node) return [];
        if (node.statement === "comment") {
          const c = node as CommentNode;
          const entry = Object.entries(KIND_WORD).find(([, w]) => w === c.objectType.toUpperCase());
          if (!entry) return [];
          const type = entry[0];
          const n = flat(type) ? { name: c.target.pieces[0]! } : split(c.target);
          const o = server.objects.find((x) => x.type === type && x.name === n.name && (flat(type) || x.schema === (n as { schema: string }).schema));
          const text = c.text ? unquote(/IS\s+('(?:[^']|'')*')\s*$/i.exec(s)?.[1] ?? "") : undefined;
          if (o) {
            if (text === undefined) delete o.comment;
            else o.comment = text;
          }
          return [];
        }
        const add = (type: PostgresEntityType, schema: string | undefined, name: string) => {
          if (server.objects.some((x) => x.type === type && x.name === name && x.schema === schema)) {
            throw new PostgresQueryError(`relation "${name}" already exists`, "42P07");
          }
          server.objects.push({ type, ...(schema !== undefined ? { schema } : {}), name, create: s.replace(/\bCREATE\s+OR\s+REPLACE\s+/i, "CREATE ") });
        };
        switch (node.statement) {
          case "schema":
            add(POSTGRES_ENTITY_TYPES.schema, undefined, node.name!.pieces[0]!);
            break;
          case "extension":
            add(POSTGRES_ENTITY_TYPES.extension, undefined, node.name.pieces[0]!);
            break;
          case "table":
          case "sequence":
          case "enum":
          case "domain": {
            const n = split(node.name);
            const type = { table: POSTGRES_ENTITY_TYPES.table, sequence: POSTGRES_ENTITY_TYPES.sequence, enum: POSTGRES_ENTITY_TYPES.enum, domain: POSTGRES_ENTITY_TYPES.domain }[node.statement];
            add(type, n.schema, n.name);
            break;
          }
          case "view": {
            const n = split(node.name);
            const type = node.materialized ? POSTGRES_ENTITY_TYPES.materializedView : POSTGRES_ENTITY_TYPES.view;
            if (node.orReplace) {
              const o = server.objects.find((x) => x.type === type && x.name === n.name && x.schema === n.schema);
              if (o) {
                o.create = s.replace(/\bCREATE\s+OR\s+REPLACE\s+/i, "CREATE ");
                break;
              }
            }
            add(type, n.schema, n.name);
            break;
          }
          case "index":
            add(POSTGRES_ENTITY_TYPES.index, split(node.table).schema, node.name!.pieces[0]!);
            break;
        }
        return [];
      },
      async end() {},
    },
  };
  return server;
}
