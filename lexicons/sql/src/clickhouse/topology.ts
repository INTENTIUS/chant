/**
 * One ClickHouse statement rendered for the topology it runs on (#3645):
 * a single node, a cluster (`ON CLUSTER`), a `Replicated` database, or
 * ClickHouse Cloud.
 *
 * A migration source is written once. What differs between topologies is
 * two things, and this module rewrites only those:
 *
 * - `ON CLUSTER`. A cluster's DDL carries it so every host runs the
 *   statement. A single node has no cluster to name. A `Replicated`
 *   database replicates its own DDL and refuses `ON CLUSTER` naming any
 *   other cluster ("ON CLUSTER is not allowed for Replicated database",
 *   code 80 on 26.8) unless `ignore_on_cluster_for_replicated_database` is
 *   set (default 0). Cloud's databases are Replicated, so the same holds
 *   there.
 * - The table engine. A MergeTree-family table replicates its rows only as
 *   `Replicated*MergeTree`. On a cluster that engine names its Keeper path
 *   and replica; inside a `Replicated` database it takes no path arguments,
 *   since `database_replicated_allow_replicated_engine_arguments` defaults to
 *   0 (refuse them) and the database supplies its own. A single node has no
 *   Keeper to replicate through, so it gets the plain family. Cloud converts
 *   every MergeTree and `Replicated*` engine to its `Shared*` equivalent
 *   itself ("You don't add a `Shared` or `Replicated` prefix yourself",
 *   https://clickhouse.com/docs/whats-new/cloud-compatibility), so it gets
 *   the plain family as well, with no path arguments to clash.
 *
 * Every function here is pure: SQL in, SQL out, nothing sent. Statements
 * this module does not recognize (`INSERT`, `SELECT`, `SYSTEM`) come back
 * unchanged, so a caller can pass every statement it sends.
 */

import { isTrivia, tokenizeText, type Token } from "./tokens";
import { parseCreate, unquote, type CreateNode, type Span } from "./parser";

/** Where the statements run. */
export type Topology =
  | { kind: "single" }
  | {
      kind: "cluster";
      /** The cluster's name in `remote_servers`, or a macro such as `{cluster}`. */
      cluster: string;
      /** Keeper path for a `Replicated*MergeTree` the renderer writes. Default {@link DEFAULT_REPLICA_PATH}. */
      replicaPath?: string;
      /** Replica name for a `Replicated*MergeTree` the renderer writes. Default {@link DEFAULT_REPLICA_NAME}. */
      replicaName?: string;
    }
  | {
      kind: "replicated";
      /**
       * A cluster to create and drop the `Replicated` databases themselves
       * on, as `CREATE DATABASE ... ON CLUSTER` reaches every replica.
       * Statements inside the database never carry it.
       */
      cluster?: string;
    }
  | { kind: "cloud" };

export type TopologyKind = Topology["kind"];

/**
 * The Keeper path a cluster's `Replicated*MergeTree` gets: the server's own
 * `default_replica_path`. `{uuid}` is the same on every host because the
 * `CREATE` runs `ON CLUSTER`, and it does not change when the table is
 * renamed or exchanged, so a rebuild's new table never shares the old one's
 * path.
 */
export const DEFAULT_REPLICA_PATH = "/clickhouse/tables/{uuid}/{shard}";
/** The replica name a cluster's `Replicated*MergeTree` gets: the server's `default_replica_name`. */
export const DEFAULT_REPLICA_NAME = "{replica}";

/** The Keeper path a `Replicated` database is created with in the `replicated` topology. */
export const replicatedDatabasePath = (database: string): string => `/clickhouse/databases/${database}`;

/**
 * Read a topology from its string form, as a command-line flag or an
 * environment variable gives it: `single`, `cluster:<name>`, `replicated`,
 * `replicated:<cluster>`, `cloud`.
 */
export function parseTopology(value: string): Topology {
  const at = value.indexOf(":");
  const kind = (at < 0 ? value : value.slice(0, at)).trim();
  const arg = at < 0 ? undefined : value.slice(at + 1).trim();
  switch (kind) {
    case "single":
    case "cloud":
      if (arg !== undefined) throw new Error(`topology ${kind} takes no argument: ${JSON.stringify(value)}`);
      return { kind };
    case "cluster":
      if (!arg) throw new Error(`topology cluster needs the cluster's name: cluster:<name>, got ${JSON.stringify(value)}`);
      return { kind, cluster: arg };
    case "replicated":
      return arg ? { kind, cluster: arg } : { kind };
    default:
      throw new Error(`unknown topology ${JSON.stringify(value)}: expected single, cluster:<name>, replicated or cloud`);
  }
}

// ── engines ───────────────────────────────────────────────────────────

/** An engine as a statement names it: its name and, if it has a parenthesised list, each argument's text. */
export interface EngineClause {
  name: string;
  args?: string[];
}

const FAMILY = /^(Replicated)?(\w*MergeTree)$/;
const isStringLiteral = (arg: string | undefined): boolean => arg !== undefined && /^'(?:[^'\\]|\\.)*'$/s.test(arg.trim());
const sqlString = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * A MergeTree-family engine split into its family and its own arguments,
 * with the Keeper path and replica name a `Replicated*` engine names taken
 * apart. Undefined for any other engine (`Log`, `Distributed`) and for a
 * `Shared*` one, which only Cloud writes.
 *
 * As ClickHouse reads it, a `Replicated*MergeTree` names a path and replica
 * when its first argument is a string literal; otherwise every argument is
 * the family's own (`ReplicatedReplacingMergeTree(ver)`).
 */
function mergeTreeFamily(engine: EngineClause): { family: string; replicated: boolean; replica?: [string, string]; args: string[] } | undefined {
  const m = FAMILY.exec(engine.name);
  if (!m || m[2]!.startsWith("Shared")) return undefined;
  const args = (engine.args ?? []).map((a) => a.trim());
  if (m[1] && isStringLiteral(args[0]) && isStringLiteral(args[1])) {
    return { family: m[2]!, replicated: true, replica: [args[0]!, args[1]!], args: args.slice(2) };
  }
  return { family: m[2]!, replicated: m[1] !== undefined, args };
}

/**
 * The engine a table gets on a topology. A MergeTree-family engine becomes
 * `Replicated*` on a cluster (with the path and replica it declared, or the
 * topology's) and in a Replicated database (with none); the plain family on
 * a single node and on Cloud. Any other engine is returned as declared.
 */
export function renderEngine(engine: EngineClause, topology: Topology): EngineClause {
  const f = mergeTreeFamily(engine);
  if (!f) return engine;
  const parens = engine.args !== undefined;
  const withArgs = (name: string, args: string[]): EngineClause => (args.length > 0 || parens ? { name, args } : { name });
  switch (topology.kind) {
    case "single":
    case "cloud":
      return withArgs(f.family, f.args);
    case "replicated":
      return withArgs(`Replicated${f.family}`, f.args);
    case "cluster": {
      const replica = f.replica ?? [sqlString(topology.replicaPath ?? DEFAULT_REPLICA_PATH), sqlString(topology.replicaName ?? DEFAULT_REPLICA_NAME)];
      return { name: `Replicated${f.family}`, args: [...replica, ...f.args] };
    }
  }
}

const engineText = (e: EngineClause): string => (e.args === undefined ? e.name : `${e.name}(${e.args.join(", ")})`);

// ── statements ────────────────────────────────────────────────────────

/** `ON CLUSTER` and the name after it: a backquoted identifier, or a string literal for a macro (`'{cluster}'`). */
export function onClusterClause(cluster: string): string {
  return `ON CLUSTER ${/[{}]/.test(cluster) ? sqlString(cluster) : `\`${cluster.replace(/`/g, "``")}\``}`;
}

interface Edit {
  /** Token index the replaced range starts at. */
  from: number;
  /** Token index past its end; equal to `from` for an insertion. */
  to: number;
  text: string;
}

function applyEdits(tokens: Token[], edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  let out = "";
  let at = 0;
  for (const e of sorted) {
    out += tokens.slice(at, e.from).map((t) => t.text).join("") + e.text;
    at = e.to;
  }
  return out + tokens.slice(at).map((t) => t.text).join("");
}

const word = (t: Token | undefined, ...words: string[]): boolean => t !== undefined && t.kind === "ident" && words.includes(t.text.toUpperCase());
const isName = (t: Token | undefined): boolean => t !== undefined && (t.kind === "ident" || t.kind === "qident" || t.kind === "number" || t.kind === "ref");

/** A walker over the significant tokens, which knows each one's index in the full list. */
class Walk {
  private readonly sig: number[];
  p = 0;
  constructor(readonly tokens: Token[]) {
    this.sig = tokens.flatMap((t, i) => (isTrivia(t) ? [] : [i]));
  }
  peek(n = 0): Token | undefined {
    const i = this.sig[this.p + n];
    return i === undefined ? undefined : this.tokens[i];
  }
  /** Index in `tokens` of the significant token `n` ahead, or the end. */
  index(n = 0): number {
    return this.sig[this.p + n] ?? this.tokens.length;
  }
  /** Index in `tokens` just past the last significant token consumed. */
  end(): number {
    return this.p === 0 ? 0 : this.sig[this.p - 1]! + 1;
  }
  accept(...words: string[]): boolean {
    if (!word(this.peek(), ...words)) return false;
    this.p++;
    return true;
  }
  acceptSeq(...words: string[]): boolean {
    if (!words.every((w, i) => word(this.peek(i), w))) return false;
    this.p += words.length;
    return true;
  }
  /** `name` or `db.name`. False when no name is here. */
  name(): boolean {
    if (!isName(this.peek())) return false;
    this.p++;
    while (this.peek()?.text === "." && isName(this.peek(1))) this.p += 2;
    return true;
  }
  /** The significant token index of the last top-level `SETTINGS`, outside any parentheses, or undefined. */
  topLevelSettings(): number | undefined {
    let depth = 0;
    let found: number | undefined;
    for (let k = this.p; k < this.sig.length; k++) {
      const t = this.tokens[this.sig[k]!]!;
      if (t.text === "(") depth++;
      else if (t.text === ")") depth--;
      else if (depth === 0 && word(t, "SETTINGS")) found = k;
    }
    return found;
  }
  /** Index in `tokens` of the significant token `k` (absolute), or the end of the statement. */
  at(k: number): number {
    return this.sig[k] ?? this.tokens.length;
  }
  /** Index in `tokens` past the last significant token, ignoring a trailing `;`. */
  bodyEnd(): number {
    let k = this.sig.length - 1;
    if (k >= 0 && this.tokens[this.sig[k]!]!.text === ";") k--;
    return k < 0 ? 0 : this.sig[k]! + 1;
  }
}

/**
 * The edit that makes the `ON CLUSTER` at the walker's position what the
 * topology wants: replaced with the topology's cluster, removed, or (when
 * there is none and `cluster` is given) inserted at `insertAt`.
 */
function onClusterEdit(w: Walk, cluster: string | undefined, insertAt: number): Edit | undefined {
  if (word(w.peek(), "ON") && word(w.peek(1), "CLUSTER")) {
    // Back to the end of the token before ON, so removing it takes its leading space too.
    const from = w.end();
    w.p += 2;
    if (!w.name() && w.peek()?.kind === "string") w.p++;
    const to = w.end();
    return { from, to, text: cluster === undefined ? "" : ` ${onClusterClause(cluster)}` };
  }
  return cluster === undefined ? undefined : { from: insertAt, to: insertAt, text: ` ${onClusterClause(cluster)}` };
}

/** The cluster a statement on a table or view carries on this topology, if any. */
const objectCluster = (topology: Topology): string | undefined => (topology.kind === "cluster" ? topology.cluster : undefined);
/**
 * The cluster a statement on a database itself carries on this topology, if
 * any. In the replicated topology only creating and dropping the database
 * reach every replica this way; an `ALTER` or `RENAME` of a Replicated
 * database is replicated by the database.
 */
const databaseCluster = (topology: Topology, createOrDrop = false): string | undefined =>
  topology.kind === "cluster" ? topology.cluster : topology.kind === "replicated" && createOrDrop ? topology.cluster : undefined;

const text = (tokens: Token[], span: Span): string =>
  tokens
    .slice(span.from, span.to)
    .map((t) => t.text)
    .join("")
    .trim();

/** The `ON CLUSTER` edit for a parsed `CREATE`: after the name and any `UUID '...'`. */
function createClusterEdit(tokens: Token[], node: CreateNode, cluster: string | undefined): Edit | undefined {
  if (node.onCluster) {
    let on = node.onCluster.from - 1;
    // Back over the trivia and the CLUSTER and ON keywords, to the end of what came before.
    let seen = 0;
    while (on >= 0 && seen < 2) {
      if (!isTrivia(tokens[on]!)) seen++;
      on--;
    }
    while (on >= 0 && isTrivia(tokens[on]!)) on--;
    return { from: on + 1, to: node.onCluster.to, text: cluster === undefined ? "" : ` ${onClusterClause(cluster)}` };
  }
  if (cluster === undefined) return undefined;
  const at = afterName(tokens, node);
  return { from: at, to: at, text: ` ${onClusterClause(cluster)}` };
}

/** Index in `tokens` past a `CREATE`'s name and any `UUID '...'` after it: where `ON CLUSTER` goes. */
function afterName(tokens: Token[], node: CreateNode): number {
  const w = new Walk(tokens.slice(node.name.to));
  if (w.accept("UUID") && w.peek()?.kind === "string") {
    w.p++;
    return node.name.to + w.end();
  }
  return node.name.to;
}

function renderCreate(tokens: Token[], node: CreateNode, topology: Topology): string {
  const edits: Edit[] = [];
  if (node.statement === "database") {
    const cluster = createClusterEdit(tokens, node, databaseCluster(topology, true));
    if (cluster) edits.push(cluster);
    const declared = node.engine?.name;
    if (topology.kind === "replicated") {
      if (declared !== "Replicated") {
        const name = unquote(text(tokens, node.name));
        const clause = `ENGINE = Replicated(${sqlString(replicatedDatabasePath(name))}, '{shard}', '{replica}')`;
        if (node.engine) edits.push({ from: node.engine.span.from, to: node.engine.span.to, text: clause });
        else {
          // After ON CLUSTER as declared, or where an inserted one goes; edits at one index apply in the order pushed.
          const at = node.onCluster ? node.onCluster.to : afterName(tokens, node);
          edits.push({ from: at, to: at, text: ` ${clause}` });
        }
      }
    } else if (declared === "Replicated" && node.engine) {
      // Only the replicated topology runs a Replicated database; elsewhere the server's default (Atomic, or Cloud's own).
      let from = node.engine.span.from;
      while (from > 0 && isTrivia(tokens[from - 1]!)) from--;
      edits.push({ from, to: node.engine.span.to, text: "" });
    }
    return applyEdits(tokens, edits);
  }

  const cluster = createClusterEdit(tokens, node, objectCluster(topology));
  if (cluster) edits.push(cluster);
  if (node.engine) {
    const declared: EngineClause = { name: node.engine.name, ...(node.engine.args ? { args: node.engine.args.map((a) => text(tokens, a)) } : {}) };
    const rendered = renderEngine(declared, topology);
    if (engineText(rendered) !== engineText(declared)) {
      // From the engine's name to the end of its argument list; `ENGINE =` stays as written.
      edits.push({ from: node.engine.nameSpan.from, to: node.engine.span.to, text: engineText(rendered) });
    }
  }
  return applyEdits(tokens, edits);
}

/** A `CREATE` the parser does not take (`CREATE TABLE ... AS`, a dictionary): `ON CLUSTER` after the name, the rest as written. */
function renderOtherCreate(tokens: Token[], topology: Topology): string {
  const w = new Walk(tokens);
  w.accept("CREATE");
  if (w.accept("OR")) w.accept("REPLACE");
  w.accept("TEMPORARY");
  let database = false;
  if (w.accept("DATABASE")) database = true;
  else if (w.accept("MATERIALIZED", "LIVE", "WINDOW")) w.accept("VIEW");
  else if (!w.accept("TABLE", "VIEW", "DICTIONARY")) return applyEdits(tokens, []);
  w.acceptSeq("IF", "NOT", "EXISTS");
  if (!w.name()) return applyEdits(tokens, []);
  let at = w.end();
  if (w.accept("UUID") && w.peek()?.kind === "string") {
    w.p++;
    at = w.end();
  }
  const edit = onClusterEdit(w, database ? databaseCluster(topology) : objectCluster(topology), at);
  return applyEdits(tokens, edit ? [edit] : []);
}

/**
 * The `ON CLUSTER` for a statement whose clause follows the object's name:
 * `ALTER`, `DROP`, `TRUNCATE`, `OPTIMIZE`, `DETACH`, `ATTACH`.
 */
function renderAfterName(tokens: Token[], w: Walk, cluster: string | undefined): string {
  w.acceptSeq("IF", "NOT", "EXISTS") || w.acceptSeq("IF", "EXISTS");
  if (!w.name()) return applyEdits(tokens, []);
  const edit = onClusterEdit(w, cluster, w.end());
  return applyEdits(tokens, edit ? [edit] : []);
}

/** `RENAME ... TO ...` and `EXCHANGE ... AND ...`: `ON CLUSTER` at the end, before any `SETTINGS`. */
function renderAtEnd(tokens: Token[], w: Walk, cluster: string | undefined): string {
  // An `ON CLUSTER` already written, after the renames.
  for (let n = 0; w.peek(n) !== undefined; n++) {
    if (word(w.peek(n), "ON") && word(w.peek(n + 1), "CLUSTER")) {
      w.p += n;
      return applyEdits(tokens, [onClusterEdit(w, cluster, 0)!]);
    }
  }
  if (cluster === undefined) return applyEdits(tokens, []);
  const settings = w.topLevelSettings();
  let at: number;
  if (settings !== undefined) {
    at = w.at(settings);
    while (at > 0 && isTrivia(tokens[at - 1]!)) at--;
  } else at = w.bodyEnd();
  return applyEdits(tokens, [{ from: at, to: at, text: ` ${onClusterClause(cluster)}` }]);
}

/**
 * One statement as it runs on `topology`: `ON CLUSTER` added, replaced or
 * removed, and in a `CREATE`, the engine the topology needs. Comments,
 * spacing and everything else in the statement are kept as written.
 * A statement that is not DDL on a database, table or view is returned
 * unchanged, as is `KILL QUERY`/`KILL MUTATION` everywhere but a cluster,
 * where it gains `ON CLUSTER` (inside a Replicated database
 * `KILL QUERY ON CLUSTER '<db>'` names the database's own cluster and is kept).
 */
export function renderStatement(sql: string, topology: Topology): string {
  const tokens = tokenizeText(sql, 0);
  const w = new Walk(tokens);
  const head = w.peek();
  if (word(head, "CREATE")) {
    let node: CreateNode | undefined;
    try {
      node = parseCreate(tokens);
    } catch {
      node = undefined;
    }
    return node ? renderCreate(tokens, node, topology) : renderOtherCreate(tokens, topology);
  }
  if (word(head, "ALTER", "DROP", "DETACH", "ATTACH", "TRUNCATE", "OPTIMIZE", "UNDROP")) {
    w.p++;
    if (word(head, "DROP", "DETACH", "ATTACH")) w.accept("TEMPORARY");
    if (w.accept("DATABASE")) return renderAfterName(tokens, w, databaseCluster(topology, word(head, "DROP")));
    // `TRUNCATE t` may leave out TABLE.
    if (w.accept("TABLE", "VIEW", "DICTIONARY") || word(head, "TRUNCATE")) return renderAfterName(tokens, w, objectCluster(topology));
    return sql;
  }
  if (word(head, "RENAME")) {
    w.p++;
    if (w.accept("DATABASE")) return renderAtEnd(tokens, w, databaseCluster(topology));
    if (w.accept("TABLE", "DICTIONARY")) return renderAtEnd(tokens, w, objectCluster(topology));
    return sql;
  }
  if (word(head, "EXCHANGE")) {
    w.p++;
    if (w.accept("TABLES", "DICTIONARIES")) return renderAtEnd(tokens, w, objectCluster(topology));
    return sql;
  }
  if (word(head, "KILL") && topology.kind === "cluster") {
    w.p++;
    if (!w.accept("QUERY", "MUTATION")) return sql;
    const edit = onClusterEdit(w, topology.cluster, w.end());
    return applyEdits(tokens, edit ? [edit] : []);
  }
  return sql;
}

/** Each step's statement rendered for `topology`; every other field of a step is kept. */
export function renderSteps<S extends { sql: string }>(steps: readonly S[], topology: Topology): S[] {
  return steps.map((s) => ({ ...s, sql: renderStatement(s.sql, topology) }));
}

/**
 * A statement for a topology that may not be configured: with none, the
 * statement as the source wrote it. The applier, the plan and the rebuild
 * migration render only when an environment names its topology
 * (`sql.profiles.<env>.topology`, `CLICKHOUSE_TOPOLOGY`), so a project that
 * names none sends what it declared, as before.
 */
export const renderFor = (sql: string, topology: Topology | undefined): string => (topology ? renderStatement(sql, topology) : sql);

/** A topology from its string form or its object form (`sql.profiles.<env>.topology`). */
export function toTopology(value: string | Topology): Topology {
  return typeof value === "string" ? parseTopology(value) : value;
}

/** The topology's string form, as `parseTopology` reads it. Replica path options are not part of it. */
export function topologyLabel(topology: Topology): string {
  switch (topology.kind) {
    case "cluster":
      return `cluster:${topology.cluster}`;
    case "replicated":
      return topology.cluster ? `replicated:${topology.cluster}` : "replicated";
    default:
      return topology.kind;
  }
}
