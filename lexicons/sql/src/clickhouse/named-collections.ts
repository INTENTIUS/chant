/**
 * Named collections, referenced by name (#4395).
 *
 * A named collection holds an integration's connection settings and its
 * credentials. Those are the environment's, so chant never declares one and
 * never reads its values (the coverage table's `referenced` status,
 * `../coverage/clickhouse.json`). A declaration may name one where the server
 * takes a collection in place of inline arguments:
 *
 * - an integration engine's first argument: `ENGINE = S3(lake_creds, format = 'Parquet')`,
 *   `ENGINE = Kafka(kafka_creds)`, a database's `ENGINE = PostgreSQL(pg_creds)`;
 * - a table function's first argument: `AS s3(lake_creds)`, `SELECT ... FROM mysql(mysql_creds, table = 't')`;
 * - a dictionary source's `NAME`: `SOURCE(MYSQL(NAME mysql_creds))`.
 *
 * The build records each reference (`namedCollections` on the object and on
 * the document, `../serializer.ts`), and `chant sql plan` checks that every
 * one exists on the server by name (`./plan/commands.ts`).
 */

import { DATABASE_ENGINES, TABLE_ENGINES, TABLE_FUNCTIONS } from "../generated/clickhouse";
import { unquoteWith } from "../core/cursor";
import { isTrivia, tokenizeText, type Token } from "./tokens";

/**
 * The table and database engines whose first argument may be a named
 * collection, as the 26.8 reference documents them for each engine.
 * Filtered to the engines the pinned server has.
 */
const COLLECTION_ENGINE_NAMES = [
  "S3",
  "S3Queue",
  "AzureBlobStorage",
  "AzureQueue",
  "Iceberg",
  "IcebergS3",
  "IcebergAzure",
  "DeltaLake",
  "DeltaLakeS3",
  "DeltaLakeAzure",
  "Hudi",
  "Paimon",
  "PaimonS3",
  "HDFS",
  "URL",
  "Kafka",
  "RabbitMQ",
  "NATS",
  "MySQL",
  "PostgreSQL",
  "MaterializedPostgreSQL",
  "MongoDB",
  "Redis",
  "ArrowFlight",
  "YTsaurus",
  "DataLakeCatalog",
];

const ENGINES = { ...TABLE_ENGINES, ...DATABASE_ENGINES } as Readonly<Record<string, unknown>>;

/** The engines a named collection may be the first argument of. */
export const COLLECTION_ENGINES: ReadonlySet<string> = new Set(COLLECTION_ENGINE_NAMES.filter((n) => n in ENGINES));

/**
 * The table functions a named collection may be the first argument of, lower
 * case. A `...Cluster` function's first argument is the cluster, so those are
 * left out.
 */
export const COLLECTION_FUNCTIONS: ReadonlySet<string> = new Set(
  TABLE_FUNCTIONS.filter(
    (f) => !/Cluster$/.test(f) && /^(s3|gcs|oss|cosn|url|hdfs|mysql|postgresql|mongodb|redis|remote|azureblobstorage|iceberg|deltalake|hudi|paimon|arrowflight|ytsaurus)/i.test(f),
  ).map((f) => f.toLowerCase()),
);

/** `lake_creds` or `` `lake creds` ``: an identifier, not a string, a call or `key = value`. */
function identifierName(text: string): string | undefined {
  const t = text.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return t.toUpperCase() === "NOSIGN" ? undefined : t;
  if (/^`(?:[^`\\]|\\.)+`$/.test(t)) return unquoteWith(t, "`");
  return undefined;
}

/** The collection an engine names in its first argument, when it is one of the engines that take one. */
export function engineCollection(engine: { name: string; args?: readonly string[] } | undefined): string | undefined {
  if (!engine || !COLLECTION_ENGINES.has(engine.name) || !engine.args || engine.args.length === 0) return undefined;
  return identifierName(engine.args[0]!);
}

const significant = (text: string): Token[] => {
  try {
    return tokenizeText(text, 0).filter((t) => !isTrivia(t));
  } catch {
    return [];
  }
};

/** The collections a SQL text's table function calls name: `s3(lake_creds, ...)`, `mysql(mysql_creds)`. */
export function functionCollections(text: string): string[] {
  const tokens = significant(text);
  const out: string[] = [];
  for (let i = 0; i + 3 < tokens.length; i++) {
    const [fn, open, arg, after] = [tokens[i]!, tokens[i + 1]!, tokens[i + 2]!, tokens[i + 3]!];
    if (fn.kind !== "ident" || !COLLECTION_FUNCTIONS.has(fn.text.toLowerCase())) continue;
    if (open.kind !== "punct" || open.text !== "(") continue;
    if (tokens[i - 1]?.kind === "punct" && tokens[i - 1]!.text === ".") continue;
    if (arg.kind !== "ident" && arg.kind !== "qident") continue;
    if (after.kind !== "punct" || (after.text !== "," && after.text !== ")")) continue;
    const name = identifierName(arg.text);
    if (name) out.push(name);
  }
  return out;
}

/** The collection a dictionary source names: `MYSQL(NAME mysql_creds)`. */
export function sourceCollections(dataSource: string): string[] {
  const tokens = significant(dataSource);
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i]!.kind !== "ident" || tokens[i]!.text.toUpperCase() !== "NAME") continue;
    const v = tokens[i + 1]!;
    if (v.kind === "ident" || v.kind === "qident") out.push(v.kind === "qident" ? unquoteWith(v.text, '`"') : v.text);
    else if (v.kind === "string") out.push(unquoteWith(v.text, "'"));
  }
  return out;
}

/** What a declaration's props hold that can name a collection. */
export interface CollectionReferrer {
  engine?: { name: string; args?: readonly string[] };
  asFunction?: string;
  select?: string;
  dataSource?: string;
}

/** Every named collection an object names, once each, in the order written. */
export function namedCollectionReferences(o: CollectionReferrer): string[] {
  const names = [
    ...(engineCollection(o.engine) !== undefined ? [engineCollection(o.engine)!] : []),
    ...(o.asFunction ? functionCollections(o.asFunction) : []),
    ...(o.select ? functionCollections(o.select) : []),
    ...(o.dataSource ? sourceCollections(o.dataSource) : []),
  ];
  return [...new Set(names)];
}

/** `CREATE NAMED COLLECTION [IF NOT EXISTS] name ...`: the name, or undefined for another statement. */
export function createdCollectionName(sql: string): string | undefined {
  const m = /^\s*CREATE\s+NAMED\s+COLLECTION\s+(?:IF\s+NOT\s+EXISTS\s+)?(`(?:[^`\\]|\\.)+`|"(?:[^"\\]|\\.)+"|[A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
  return m ? unquoteWith(m[1]!, '`"') : undefined;
}

/**
 * The collections a whole statement names, read off its tokens: what
 * {@link namedCollectionReferences} reads from a parsed declaration, for a
 * statement import has only as text (`SHOW CREATE`).
 */
export function statementCollections(ddl: string): string[] {
  const tokens = significant(ddl);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "ident") continue;
    const word = t.text.toUpperCase();
    if (word === "ENGINE" && tokens[i + 1]?.text === "=" && tokens[i + 3]?.text === "(") {
      const engine = tokens[i + 2]!;
      const arg = tokens[i + 4];
      const after = tokens[i + 5];
      if (COLLECTION_ENGINES.has(engine.text) && arg && (arg.kind === "ident" || arg.kind === "qident") && (after?.text === "," || after?.text === ")")) {
        const name = identifierName(arg.text);
        if (name) out.push(name);
      }
    } else if (word === "SOURCE" && tokens[i + 1]?.text === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < tokens.length; j++) {
        if (tokens[j]!.text === "(") depth++;
        else if (tokens[j]!.text === ")" && --depth === 0) break;
      }
      out.push(...sourceCollections(tokens.slice(i + 2, j).map((x) => x.text).join(" ")));
      i = j;
    }
  }
  out.push(...functionCollections(ddl));
  return [...new Set(out)];
}

/** One environment prerequisite an import found: a named collection (#4395). */
export interface Prerequisite {
  kind: "named collection";
  name: string;
  /** The imported objects that name it, `database.name`. */
  referencedBy: string[];
}

/**
 * The named collections an import found as prerequisites (#4395), each with
 * the imported objects that name it, and a warning for each. A collection an
 * imported object names that was not found is listed too: a live reader
 * without `SHOW NAMED COLLECTIONS` sees none.
 */
export function namedCollectionPrerequisites(
  found: ReadonlyArray<{ name: string }>,
  objects: ReadonlyArray<{ database?: string; name: string; ddl: string }>,
  wording: { of?: string; found: string; unseen: string },
): { prerequisites: Prerequisite[]; warnings: string[] } {
  const by = new Map<string, string[]>(found.map((o) => [o.name, []]));
  for (const o of objects) {
    for (const c of statementCollections(o.ddl)) {
      if (!by.has(c)) by.set(c, []);
      by.get(c)!.push(o.database ? `${o.database}.${o.name}` : o.name);
    }
  }
  const prerequisites: Prerequisite[] = [...by]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, referencedBy]) => ({ kind: "named collection", name, referencedBy }));
  const seen = new Set(found.map((o) => o.name));
  const warnings = prerequisites.map((p) => {
    const used = p.referencedBy.length > 0 ? `, named by ${p.referencedBy.join(", ")}` : "";
    return (
      `named collection ${p.name} is a prerequisite${wording.of ? ` of ${wording.of}` : ""}${used}: ${seen.has(p.name) ? wording.found : wording.unseen}, ` +
      "and chant does not declare it or read its values. Create it on every server the project applies to; chant sql plan checks that it exists"
    );
  });
  return { prerequisites, warnings };
}
