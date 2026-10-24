/**
 * The Postgres statement classifier (#4407): a migration file's statements,
 * each given the class and rule the schema-diff classifier (`./rules.ts`)
 * gives the same change, with the lock the rule's restriction names. It reads
 * text and contacts no server.
 *
 * `CREATE`, `GRANT`, `REVOKE`, `COMMENT ON` and `ALTER TABLE ... ROW LEVEL
 * SECURITY` go through the declaration parser (`../parser.ts`). The parser
 * has no `ALTER` grammar, so the other `ALTER` and `DROP` statements are read
 * word by word from the same tokens.
 *
 * A statement alone cannot decide some changes. `ALTER COLUMN ... TYPE` is a
 * catalog change or a table rewrite by the column's old type, which the file
 * does not state: it is `undecided`, naming SQLPG206 and SQLPG207 (and
 * SQLPG208 with a `USING` expression). `CREATE OR REPLACE VIEW` is SQLPG250
 * or SQLPG251 by whether the columns stay. A statement no rule covers is
 * `unclassified` with a note.
 */

import { isTrivia, tokenizeText, type Token } from "../tokens";
import { parseStatements, type StatementNode } from "../parser";
import { classifiedOf, lockOf, splitTopLevel, sqlHead, type StatementClassified, type StatementVerdict } from "../../core/statement-class";
import { PG_CHANGE_CLASSES, PG_CLASSIFIER_RULES, type PgClassifierRuleId } from "./rules";

const classified = (id: PgClassifierRuleId, extra: Partial<StatementClassified> = {}): StatementClassified => {
  const lock = lockOf(PG_CLASSIFIER_RULES[id].restriction);
  return classifiedOf(PG_CLASSIFIER_RULES, PG_CHANGE_CLASSES.label, id, { ...(lock ? { lock } : {}), ...extra });
};

/** What one clause of a statement comes to. */
type Reading = { rules: Array<{ id: PgClassifierRuleId; extra?: Partial<StatementClassified> }> } | { undecided: PgClassifierRuleId[]; note: string } | { none: string } | { data: string };

const rule = (id: PgClassifierRuleId, extra?: Partial<StatementClassified>): Reading => ({ rules: [{ id, ...(extra ? { extra } : {}) }] });

const VOLATILE = /\b(?:clock_timestamp|random|gen_random_uuid|uuid_generate_v\d\w*|nextval|timeofday|txid_current|setseed)\s*\(/i;

/** The words from `i` that are one possibly qualified name, and the index after it. */
function nameAt(words: readonly string[], i: number): { name: string; next: number } {
  let name = words[i] ?? "";
  let j = i + 1;
  while (words[j] === "." && words[j + 1] !== undefined) {
    name += `.${words[j + 1]}`;
    j += 2;
  }
  return { name, next: j };
}

const bare = (name: string): string => (name.split(".").pop() ?? name).replace(/^"|"$/g, "").toLowerCase();

const has = (u: readonly string[], ...seq: string[]): boolean => u.some((_, i) => seq.every((w, k) => u[i + k] === w));

/** One `ALTER TABLE` action (the words between top-level commas). */
function tableAction(a: readonly string[]): Reading {
  const u = a.map((w) => w.toUpperCase());
  const first = u[0];
  if (first === "ADD") {
    let i = 1;
    if (u[i] === "COLUMN") i++;
    if (u[i] === "CONSTRAINT" || ["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "EXCLUDE"].includes(u[i] ?? "")) {
      let k = i;
      if (u[k] === "CONSTRAINT") k += 2;
      const kind = u[k];
      const notValid = has(u, "NOT", "VALID");
      if (kind === "NOT" && u[k + 1] === "NULL") return rule("SQLPG210");
      if (notValid) return rule("SQLPG217", { note: `${kind ?? "constraint"} added NOT VALID; VALIDATE CONSTRAINT is SQLPG220` });
      if (kind === "PRIMARY" || kind === "UNIQUE") return rule("SQLPG221", has(u, "USING", "INDEX") ? { note: "from an existing unique index, so no build under this lock" } : {});
      if (kind === "CHECK") return rule("SQLPG218");
      if (kind === "FOREIGN") return rule("SQLPG219");
      if (kind === "EXCLUDE") return rule("SQLPG222");
      return { none: "an ADD CONSTRAINT of a kind no rule names" };
    }
    if (u[i] === "IF" && u[i + 1] === "NOT" && u[i + 2] === "EXISTS") i += 3;
    const hasDefault = u.includes("DEFAULT");
    const defaultText = hasDefault ? a.slice(u.indexOf("DEFAULT") + 1).join(" ") : "";
    const generated = has(u, "GENERATED");
    const stored = u.includes("STORED") && generated;
    const identity = u.includes("IDENTITY");
    const notNull = has(u, "NOT", "NULL");
    if (stored || identity) return rule("SQLPG202", { note: stored ? "a STORED generated column" : "an identity column" });
    if (VOLATILE.test(defaultText)) return rule("SQLPG202", { note: "a volatile default" });
    if (notNull && !hasDefault && !generated) return rule("SQLPG203");
    return rule("SQLPG201");
  }
  if (first === "DROP") {
    if (u[1] === "CONSTRAINT") return rule("SQLPG223");
    return rule("SQLPG204", { destructive: true });
  }
  if (first === "RENAME") {
    if (u[1] === "COLUMN" || (u[1] !== "CONSTRAINT" && u[1] !== "TO")) return rule("SQLPG205");
    return rule("SQLPG228");
  }
  if (first === "ALTER") {
    let i = 1;
    if (u[i] === "COLUMN") i++;
    if (u[i] === "CONSTRAINT") return { none: "ALTER CONSTRAINT (deferrability)" };
    const rest = u.slice(i + 1);
    const col = a[i] ?? "column";
    if (rest[0] === "TYPE" || (rest[0] === "SET" && rest[1] === "DATA" && rest[2] === "TYPE")) {
      const using = rest.includes("USING");
      return {
        undecided: using ? ["SQLPG206", "SQLPG207", "SQLPG208"] : ["SQLPG206", "SQLPG207"],
        note: `the new type of ${col} is a catalog change or a table rewrite by its old type${using ? ", or a change across kinds with this USING expression," : ""}, which the file does not state`,
      };
    }
    if (rest[0] === "SET" && rest[1] === "DEFAULT") return rule("SQLPG209");
    if (rest[0] === "DROP" && rest[1] === "DEFAULT") return rule("SQLPG209");
    if (rest[0] === "SET" && rest[1] === "NOT" && rest[2] === "NULL") return rule("SQLPG210");
    if (rest[0] === "DROP" && rest[1] === "NOT" && rest[2] === "NULL") return rule("SQLPG211");
    if (rest[0] === "SET" && rest[1] === "EXPRESSION") return rule("SQLPG212");
    if ((rest[0] === "ADD" && rest[1] === "GENERATED") || (rest[0] === "SET" && (rest[1] === "GENERATED" || rest[1] === "INCREMENT" || rest[1] === "START" || rest[1] === "RESTART")) || rest[0] === "RESTART" || (rest[0] === "DROP" && rest[1] === "IDENTITY")) {
      return rule("SQLPG213");
    }
    if (rest[0] === "SET" && (rest[1] === "STORAGE" || rest[1] === "COMPRESSION")) return rule("SQLPG215");
    return { none: `ALTER COLUMN ${rest.slice(0, 2).join(" ")}` };
  }
  if (first === "VALIDATE" && u[1] === "CONSTRAINT") return rule("SQLPG220");
  if (first === "SET" || first === "RESET") {
    if (u[1] === "LOGGED" || u[1] === "UNLOGGED") return rule("SQLPG225");
    if (u[1] === "ACCESS" || u[1] === "TABLESPACE") return rule("SQLPG226");
    if (u[1] === "SCHEMA") return rule("SQLPG228");
    if (u[1] === "(" || first === "RESET") return rule("SQLPG224");
    return { none: `ALTER TABLE ${u.slice(0, 2).join(" ")}` };
  }
  if (first === "ATTACH" || first === "DETACH" || first === "INHERIT" || (first === "NO" && u[1] === "INHERIT") || first === "OF" || (first === "NOT" && u[1] === "OF")) return rule("SQLPG227");
  if ((first === "ENABLE" || first === "DISABLE" || first === "FORCE" || (first === "NO" && u[1] === "FORCE")) && has(u, "ROW", "LEVEL", "SECURITY")) return rule("SQLPG293");
  if ((first === "ENABLE" || first === "DISABLE") && (u[1] === "TRIGGER" || u[1] === "REPLICA" || u[1] === "ALWAYS")) return rule("SQLPG284");
  return { none: `ALTER TABLE ${u.slice(0, 2).join(" ")}` };
}

/** `ALTER <object> ...` other than `TABLE`, by its second word. */
function alterOther(u: readonly string[], a: readonly string[]): Reading {
  const obj = u[1];
  const rename = u.includes("RENAME");
  if (obj === "INDEX") return rename ? rule("SQLPG229") : rule("SQLPG243");
  if (obj === "TYPE") {
    if (has(u, "ADD", "VALUE")) return rule("SQLPG260");
    if (has(u, "RENAME", "TO")) return rule("SQLPG228");
    return { none: "ALTER TYPE other than ADD VALUE and RENAME TO" };
  }
  if (obj === "SEQUENCE") return rename || has(u, "SET", "SCHEMA") ? rule("SQLPG228") : has(u, "OWNER", "TO") ? { none: "ALTER SEQUENCE OWNER TO" } : rule("SQLPG265");
  if (obj === "VIEW") return rename || has(u, "SET", "SCHEMA") ? rule("SQLPG228") : has(u, "OWNER", "TO") ? { none: "ALTER VIEW OWNER TO" } : rule("SQLPG253");
  if (obj === "MATERIALIZED") return rename || has(u, "SET", "SCHEMA") ? rule("SQLPG228") : { none: "ALTER MATERIALIZED VIEW other than RENAME" };
  if (obj === "SCHEMA") return rename ? rule("SQLPG228") : has(u, "OWNER", "TO") ? rule("SQLPG267") : { none: "ALTER SCHEMA" };
  if (obj === "EXTENSION") return has(u, "UPDATE") || has(u, "SET", "SCHEMA") ? rule("SQLPG266") : { none: "ALTER EXTENSION ADD or DROP member" };
  if (obj === "FUNCTION" || obj === "PROCEDURE" || obj === "ROUTINE") return rename || has(u, "SET", "SCHEMA") ? rule("SQLPG228") : { none: `ALTER ${obj} other than RENAME` };
  if (obj === "TRIGGER") return rule("SQLPG284");
  if (obj === "POLICY") return rename ? rule("SQLPG228") : rule("SQLPG291");
  if (obj === "ROLE" || obj === "USER" || obj === "GROUP") return rule("SQLPG294");
  if (obj === "DOMAIN") {
    if (rename || has(u, "SET", "SCHEMA")) return rule("SQLPG228");
    if (has(u, "ADD", "CONSTRAINT") || (u[3] === "ADD" && ["CHECK", "NOT"].includes(u[4] ?? ""))) return rule("SQLPG262");
    if (has(u, "OWNER", "TO")) return { none: "ALTER DOMAIN OWNER TO" };
    return rule("SQLPG263");
  }
  if (obj === "SERVER" || obj === "PUBLICATION" || (obj === "FOREIGN" && u[2] === "DATA")) return rename ? rule("SQLPG228") : rule("SQLPG303");
  void a;
  return { none: `ALTER ${obj ?? ""}`.trim() };
}

function dropStatement(u: readonly string[]): Reading {
  const obj = u[1] === "MATERIALIZED" || u[1] === "FOREIGN" || u[1] === "EVENT" ? `${u[1]} ${u[2]}` : u[1];
  if (obj === "INDEX") return rule("SQLPG242", u[2] === "CONCURRENTLY" ? { note: "DROP INDEX CONCURRENTLY waits for running queries instead of blocking them" } : {});
  if (obj === "TRIGGER") return rule("SQLPG285", { destructive: false });
  if (obj === "POLICY") return rule("SQLPG292", { destructive: false });
  return rule("SQLPG270", { destructive: true });
}

/** How a `CREATE` that the parser could not read starts: its kind by key words. */
function createByWords(u: readonly string[]): Reading {
  let i = 1;
  const orReplace = u[i] === "OR" && u[i + 1] === "REPLACE";
  if (orReplace) i += 2;
  while (["GLOBAL", "LOCAL", "TEMPORARY", "TEMP", "UNLOGGED", "RECURSIVE", "UNIQUE", "CONSTRAINT"].includes(u[i] ?? "") && u[i + 1] !== "INDEX" && u[i] !== "UNIQUE") i++;
  if (u[i] === "UNIQUE") i++;
  if (u[i] === "INDEX") {
    const concurrently = u[i + 1] === "CONCURRENTLY";
    return concurrently ? rule("SQLPG240") : rule("SQLPG241");
  }
  if (orReplace && (u[i] === "FUNCTION" || u[i] === "PROCEDURE")) return rule("SQLPG280");
  if (orReplace && u[i] === "VIEW") return { undecided: ["SQLPG250", "SQLPG251"], note: "whether the view keeps its columns depends on the view it replaces" };
  if (orReplace && u[i] === "AGGREGATE") return rule("SQLPG302");
  if (u[i] === "TRIGGER") return rule("SQLPG283");
  if (u[i] === "POLICY") return rule("SQLPG290");
  return rule("SQLPG200");
}

/** A statement the parser read: its rule, given the tables this file created earlier. */
function fromNode(n: StatementNode, created: Set<string>): Reading {
  switch (n.statement) {
    case "table":
      created.add(bare(n.name.pieces.join(".")));
      return rule("SQLPG200");
    case "index":
      if (n.concurrently) return rule("SQLPG240");
      if (created.has(bare(n.table.pieces.join(".")))) return rule("SQLPG200", { note: "an index on a table this file creates, which has no rows to block" });
      return rule("SQLPG241");
    case "view":
      if (n.orReplace && !n.materialized) return { undecided: ["SQLPG250", "SQLPG251"], note: "whether the view keeps its columns depends on the view it replaces" };
      return rule("SQLPG200");
    case "function":
    case "procedure":
      return n.orReplace ? rule("SQLPG280") : rule("SQLPG200");
    case "aggregate":
      return n.orReplace ? rule("SQLPG302") : rule("SQLPG200");
    case "trigger":
      return created.has(bare(n.table.pieces.join("."))) ? rule("SQLPG200", { note: "a trigger on a table this file creates" }) : rule("SQLPG283");
    case "policy":
      return created.has(bare(n.table.pieces.join("."))) ? rule("SQLPG200", { note: "a policy on a table this file creates" }) : rule("SQLPG290");
    case "grant":
      return n.defaults ? rule("SQLPG298") : n.revoke ? rule("SQLPG297") : rule("SQLPG296");
    case "rowSecurity":
      return rule("SQLPG293");
    case "comment":
      return rule("SQLPG216");
    case "role":
      return rule("SQLPG200");
    default:
      return rule("SQLPG200");
  }
}

const DATA_WORDS = new Set(["INSERT", "UPDATE", "DELETE", "SELECT", "WITH", "COPY", "CALL", "DO", "SET", "BEGIN", "START", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "ANALYZE", "ANALYSE", "VACUUM", "REINDEX", "LOCK", "NOTIFY", "LISTEN", "RESET", "SHOW", "EXPLAIN", "VALUES", "MERGE", "REFRESH", "CLUSTER", "CHECKPOINT", "DISCARD", "PREPARE", "EXECUTE", "DEALLOCATE"]);

/** Classify one statement. `created` is the tables the file's earlier statements created. */
function read(sql: string, created: Set<string>): Reading[] {
  let tokens: Token[];
  try {
    tokens = tokenizeText(sql, 0);
  } catch {
    return [{ none: "text the tokenizer could not read" }];
  }
  const words = tokens.filter((t) => !isTrivia(t) && t.text !== ";").map((t) => t.text);
  const u = words.map((w) => w.toUpperCase());
  const head = u[0];
  if (head === undefined) return [{ data: "an empty statement" }];

  if (head === "CREATE" || head === "GRANT" || head === "REVOKE" || head === "COMMENT" || (head === "ALTER" && (u[1] === "DEFAULT" || (u[1] === "TABLE" && has(u, "ROW", "LEVEL", "SECURITY"))))) {
    try {
      const nodes = parseStatements(tokens);
      return nodes.map((n) => fromNode(n, created));
    } catch {
      if (head === "CREATE") return [createByWords(u)];
      if (head === "GRANT") return [rule("SQLPG296")];
      if (head === "REVOKE") return [rule("SQLPG297")];
      if (head === "COMMENT") return [rule("SQLPG216")];
      if (head === "ALTER" && u[1] === "DEFAULT") return [rule("SQLPG298")];
      return [rule("SQLPG293")];
    }
  }
  if (head === "ALTER" && u[1] === "TABLE") {
    let i = 2;
    if (u[i] === "IF" && u[i + 1] === "EXISTS") i += 2;
    if (u[i] === "ONLY") i++;
    const { name, next } = nameAt(words, i);
    if (u[next] === "*") i = next + 1;
    else i = next;
    const actions = splitTopLevel(words.slice(i));
    if (actions.length === 0) return [{ none: `ALTER TABLE ${name} with no action` }];
    void name;
    return actions.map(tableAction);
  }
  if (head === "ALTER") return [alterOther(u, words)];
  if (head === "DROP") return [dropStatement(u)];
  if (head === "TRUNCATE") return [{ data: "TRUNCATE removes every row of the table" }];
  if (DATA_WORDS.has(head)) return [{ data: `${head} reads or writes rows or the session, not the schema` }];
  return [{ none: `${head} is not a statement the classifier reads` }];
}

/**
 * Classify a migration's up statements, in order. The statements are the
 * file's own text, one per entry (a Flyway file after placeholder
 * substitution).
 */
export function classifyPgStatements(statements: readonly string[]): StatementVerdict[] {
  const created = new Set<string>();
  return statements.map((sql, k) => {
    const readings = read(sql, created);
    const out: StatementVerdict = { index: k + 1, sql: sqlHead(sql), outcome: "classified", changes: [] };
    const none: string[] = [];
    for (const r of readings) {
      if ("rules" in r) out.changes.push(...r.rules.map((x) => classified(x.id, x.extra)));
      else if ("undecided" in r) {
        out.candidates = r.undecided.map((id) => classified(id));
        out.note = r.note;
      } else if ("none" in r) none.push(r.none);
      else out.note = r.data;
    }
    if (out.candidates && out.changes.length === 0) out.outcome = "undecided";
    else if (out.candidates) {
      // A statement with some decided clauses and one undecided: report undecided, and keep the decided ones.
      out.outcome = "undecided";
    } else if (out.changes.length === 0 && none.length === 0) out.outcome = "data";
    else if (none.length > 0) {
      out.outcome = out.changes.length > 0 ? "classified" : "unclassified";
      out.note = [out.note, `no rule covers ${none.join("; ")}`].filter(Boolean).join("; ");
    }
    return out;
  });
}
