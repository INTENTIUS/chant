/**
 * The needs-review catalog: the judgment calls that turn a table from another
 * database into a ClickHouse table, each as a finding with the evidence it
 * used. A source reader (`chant import` of SQL Server, #4398; `chant migrate`
 * of Postgres, #4399) does the mechanical work, a type map and a rename,
 * and asks this module for everything that is a decision.
 *
 * Nothing here knows a source dialect. A reader describes its table in the
 * neutral facts below (a candidate sort key, a column's nullability, a
 * constraint) and gets back the ClickHouse choice, a finding to report, and
 * for a constraint the comment lines to keep in the DDL. The rules are the
 * same whichever database the table came from.
 *
 * ## API
 *
 * - {@link sortKeyReview}: `ORDER BY` from the candidates the source offers,
 *   in the priority `explicit-order`, `clustering-key`, `primary-key`,
 *   `unique-key`, then `tuple()`. Returns `orderBy`, the `settings` the key
 *   needs (`allow_nullable_key` when a key column is `Nullable`), and a
 *   finding that names the chosen candidate and the others it passed over.
 * - {@link engineReview}: `MergeTree` for an append-only table;
 *   `ReplacingMergeTree(_version, _deleted)` for a CDC mirror, with the two
 *   columns it adds in `extraColumns`.
 * - {@link nullableReview}: a column's final type. A `NOT NULL` column keeps
 *   its type with no finding. A nullable column becomes `Nullable(T)` with a
 *   finding; when it has a default the finding says the default could
 *   replace `Nullable`.
 * - {@link lowCardinalityReview}: a finding for a `String` column whose name
 *   and declared length suggest few distinct values. It never changes the
 *   type; offline, the name and the type are all there is to read.
 * - {@link constraintReview}: foreign keys, checks and unique constraints,
 *   which ClickHouse does not enforce. Returns `comments` (SQL `--` lines to
 *   put before the `CREATE`) and one finding per constraint.
 * - {@link REVIEW_RULES}: every rule id with its summary and the ClickHouse
 *   documentation it rests on, for report metadata.
 * - {@link findingText}: a finding as one line (object, message, evidence,
 *   suggestion), the form a SARIF `message` takes.
 *
 * A finding's `severity` is `warning` for a decision the author must confirm
 * and `info` for a note that changes nothing. The caller maps findings to its
 * own diagnostic type; `at` carries the source line and column when the
 * reader knows them.
 *
 * Every ClickHouse type and engine this module writes is checked against the
 * pinned catalog (`src/generated/clickhouse.ts`, ClickHouse 26.8) in
 * `review-catalog.test.ts`, so a pin move that drops one fails there.
 *
 * Sources: the MergeTree sorting key and `allow_nullable_key`
 * (https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree),
 * `ReplacingMergeTree(ver, is_deleted)`
 * (https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree),
 * `Nullable` (https://clickhouse.com/docs/sql-reference/data-types/nullable),
 * `LowCardinality`
 * (https://clickhouse.com/docs/sql-reference/data-types/lowcardinality).
 */

export type ReviewSeverity = "warning" | "info";

export type ReviewRuleId =
  | "SQLRV001"
  | "SQLRV002"
  | "SQLRV003"
  | "SQLRV004"
  | "SQLRV005"
  | "SQLRV006"
  | "SQLRV007"
  | "SQLRV008"
  | "SQLRV009"
  | "SQLRV010"
  | "SQLRV011"
  | "SQLRV012";

export interface ReviewRule {
  id: ReviewRuleId;
  name: string;
  summary: string;
  docs: readonly string[];
}

const CH_MERGETREE = "https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree";

/**
 * The rules. SQLRV001 to SQLRV005 are the shared ones; the rest are raised by
 * a source reader for what only its dialect has, and live here so a report
 * lists one catalog.
 */
export const REVIEW_RULES: Readonly<Record<ReviewRuleId, ReviewRule>> = {
  SQLRV001: {
    id: "SQLRV001",
    name: "sort-key",
    summary: "The ORDER BY key is a suggestion from the source's indexes.",
    docs: [CH_MERGETREE],
  },
  SQLRV002: {
    id: "SQLRV002",
    name: "engine",
    summary: "The table engine is a choice the source does not make.",
    docs: [CH_MERGETREE, "https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree"],
  },
  SQLRV003: {
    id: "SQLRV003",
    name: "nullable",
    summary: "A nullable column becomes Nullable(T), which costs storage and speed; a default can replace it.",
    docs: ["https://clickhouse.com/docs/sql-reference/data-types/nullable"],
  },
  SQLRV004: {
    id: "SQLRV004",
    name: "low-cardinality",
    summary: "A String column that may hold few distinct values could be LowCardinality(String).",
    docs: ["https://clickhouse.com/docs/sql-reference/data-types/lowcardinality"],
  },
  SQLRV005: {
    id: "SQLRV005",
    name: "constraint",
    summary: "ClickHouse does not enforce this constraint; it is kept as a comment.",
    docs: ["https://clickhouse.com/docs/sql-reference/statements/create/table"],
  },
  SQLRV006: {
    id: "SQLRV006",
    name: "generated-column",
    summary: "An identity, sequence, computed or system-generated column has no ClickHouse equivalent.",
    docs: ["https://clickhouse.com/docs/sql-reference/statements/create/table"],
  },
  SQLRV007: {
    id: "SQLRV007",
    name: "type-judgment",
    summary: "The type has no exact ClickHouse match; the nearest one was chosen.",
    docs: ["https://clickhouse.com/docs/sql-reference/data-types"],
  },
  SQLRV008: {
    id: "SQLRV008",
    name: "default-expression",
    summary: "A default expression was translated or dropped.",
    docs: ["https://clickhouse.com/docs/sql-reference/statements/create/table"],
  },
  SQLRV009: {
    id: "SQLRV009",
    name: "storage-option",
    summary: "A storage option of the source (filegroup, partitioning, compression, versioning) has no counterpart here.",
    docs: [CH_MERGETREE],
  },
  SQLRV010: {
    id: "SQLRV010",
    name: "query-text",
    summary: "A view body is copied as written and is not translated.",
    docs: ["https://clickhouse.com/docs/sql-reference/statements/create/view"],
  },
  SQLRV011: {
    id: "SQLRV011",
    name: "not-carried",
    summary: "An object or statement of the source is not carried over, and is named here.",
    docs: [],
  },
  SQLRV012: {
    id: "SQLRV012",
    name: "emulator-rejected",
    summary: "The ClickHouse emulator refused a statement the import would write.",
    docs: [],
  },
};

export interface SourcePosition {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export interface ReviewFinding {
  ruleId: ReviewRuleId;
  severity: ReviewSeverity;
  /** The table or view the finding is about, as the source names it. */
  object: string;
  /** The column, when the finding is about one. */
  column?: string;
  message: string;
  /** What the decision was read from: each entry is a fact in the source. */
  evidence: readonly string[];
  suggestion?: string;
  at?: SourcePosition;
}

/** A finding as one line. */
export function findingText(f: ReviewFinding): string {
  const where = f.column ? `${f.object}.${f.column}` : f.object;
  const parts = [`${where}: ${f.message}`];
  if (f.evidence.length > 0) parts.push(`Evidence: ${f.evidence.join("; ")}.`);
  if (f.suggestion) parts.push(`Suggestion: ${f.suggestion}`);
  return parts.join(" ");
}

const q = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, "\\`")}\``);
const list = (names: readonly string[]): string => names.join(", ");

// --- sort key -------------------------------------------------------------

/**
 * Where a candidate sort key came from, strongest first. `explicit-order` is
 * an ordering the author declared for storage (a columnstore `ORDER`),
 * `clustering-key` the key the source stores rows in (a clustered index),
 * then the primary key and the first unique key.
 */
export type SortKeyKind = "explicit-order" | "clustering-key" | "primary-key" | "unique-key";

const SORT_KEY_PRIORITY: readonly SortKeyKind[] = ["explicit-order", "clustering-key", "primary-key", "unique-key"];

export interface SortKeyCandidate {
  kind: SortKeyKind;
  /** The index or constraint name, for the evidence. */
  name?: string;
  columns: readonly string[];
  /** Columns the source sorts descending; ClickHouse's `ORDER BY` drops the direction. */
  descending?: readonly string[];
  /** The fact this candidate was read from, e.g. `CREATE CLUSTERED INDEX CX_t`. */
  source: string;
}

export interface SortKeyInput {
  object: string;
  candidates: readonly SortKeyCandidate[];
  /** Each column's ClickHouse type, by name; `Nullable(...)` marks a nullable key column. */
  columnTypes: Readonly<Record<string, string>>;
  at?: SourcePosition;
}

export interface SortKeyResult {
  orderBy: string[];
  /** MergeTree settings the key needs. */
  settings: Record<string, string>;
  finding: ReviewFinding;
}

export function sortKeyReview(input: SortKeyInput): SortKeyResult {
  const ranked = SORT_KEY_PRIORITY.flatMap((kind) => input.candidates.filter((c) => c.kind === kind && c.columns.length > 0));
  const chosen = ranked[0];
  const evidence: string[] = [];
  const settings: Record<string, string> = {};
  let orderBy: string[] = [];
  let message: string;
  let suggestion: string | undefined;
  if (chosen) {
    orderBy = [...chosen.columns];
    evidence.push(`${chosen.source} (${list(chosen.columns)})`);
    for (const other of ranked.slice(1)) evidence.push(`passed over: ${other.source} (${list(other.columns)})`);
    if (chosen.descending && chosen.descending.length > 0) evidence.push(`descending in the source, ascending here: ${list(chosen.descending)}`);
    const nullable = orderBy.filter((c) => (input.columnTypes[c] ?? "").startsWith("Nullable("));
    if (nullable.length > 0) {
      settings.allow_nullable_key = "1";
      evidence.push(`Nullable key column${nullable.length > 1 ? "s" : ""}: ${list(nullable)}, so allow_nullable_key = 1 is set`);
    }
    message = `ORDER BY (${list(orderBy.map(q))}) suggested from the ${chosen.kind.replace("-", " ")}.`;
    suggestion = "Put the columns your queries filter on first, and the one with the fewest distinct values before the one with the most.";
  } else {
    orderBy = [];
    evidence.push("no clustering key, primary key or unique key in the source");
    message = "ORDER BY tuple() used because the source gives no key to suggest.";
    suggestion = "Choose the columns your queries filter on; a MergeTree table without a sort key cannot skip granules.";
  }
  return {
    orderBy,
    settings,
    finding: { ruleId: "SQLRV001", severity: "warning", object: input.object, message, evidence, ...(suggestion ? { suggestion } : {}), ...(input.at ? { at: input.at } : {}) },
  };
}

// --- engine ---------------------------------------------------------------

export interface EngineInput {
  object: string;
  /**
   * `append` for a table that is loaded and queried, `cdc` for a mirror of a
   * table that changes in place (#4399): rows arrive as new versions and a
   * delete arrives as a marker row.
   */
  mode: "append" | "cdc";
  /** Facts about the source table that bear on the choice, as plain sentences. */
  facts?: readonly string[];
  /** The columns the source enforces unique, when it does. */
  uniqueKey?: readonly string[];
  at?: SourcePosition;
}

export interface EngineResult {
  /** The text after `ENGINE =`. */
  engine: string;
  /** Columns the engine needs and the source does not have. */
  extraColumns: Array<{ name: string; type: string }>;
  finding: ReviewFinding;
}

export const CDC_VERSION_COLUMN = { name: "_version", type: "UInt64" } as const;
export const CDC_DELETED_COLUMN = { name: "_deleted", type: "UInt8" } as const;

export function engineReview(input: EngineInput): EngineResult {
  const evidence = [...(input.facts ?? [])];
  const unique = input.uniqueKey && input.uniqueKey.length > 0 ? list(input.uniqueKey) : undefined;
  if (input.mode === "cdc") {
    evidence.push(`the table is mirrored from a source that updates rows in place${unique ? `, keyed on (${unique})` : ""}`);
    return {
      engine: `ReplacingMergeTree(${CDC_VERSION_COLUMN.name}, ${CDC_DELETED_COLUMN.name})`,
      extraColumns: [{ ...CDC_VERSION_COLUMN }, { ...CDC_DELETED_COLUMN }],
      finding: {
        ruleId: "SQLRV002",
        severity: "warning",
        object: input.object,
        message: "ReplacingMergeTree(_version, _deleted) chosen for a mirror; it adds the columns _version and _deleted.",
        evidence,
        suggestion: "The sort key must be the source key, because rows with an equal sort key collapse to the highest _version on merge. Read with FINAL, or filter on _deleted, to see the collapsed rows before a merge.",
        ...(input.at ? { at: input.at } : {}),
      },
    };
  }
  if (unique) evidence.push(`the source enforces uniqueness on (${unique}); MergeTree does not`);
  return {
    engine: "MergeTree",
    extraColumns: [],
    finding: {
      ruleId: "SQLRV002",
      severity: "warning",
      object: input.object,
      message: "MergeTree chosen; the source has no engine to carry over.",
      evidence,
      suggestion: unique
        ? "If rows can arrive twice, ReplacingMergeTree collapses duplicates of the sort key on merge, not on insert."
        : "Pick another MergeTree variant for pre-aggregation (SummingMergeTree, AggregatingMergeTree) when the table is a rollup.",
      ...(input.at ? { at: input.at } : {}),
    },
  };
}

// --- Nullable -------------------------------------------------------------

export interface NullableInput {
  object: string;
  column: string;
  /** The column's ClickHouse type before `Nullable`. */
  type: string;
  sourceNullable: boolean;
  /** The default as the ClickHouse expression it became, or the source text when it did not translate. */
  defaultExpr?: string;
  at?: SourcePosition;
}

export interface NullableResult {
  type: string;
  finding?: ReviewFinding;
}

export function nullableReview(input: NullableInput): NullableResult {
  if (!input.sourceNullable) return { type: input.type };
  const evidence = [`${input.column} allows NULL in the source`];
  let suggestion: string;
  if (input.defaultExpr !== undefined) {
    evidence.push(`it has the default ${input.defaultExpr}`);
    suggestion = `If NULL is never stored on purpose, declare ${input.type} DEFAULT ${input.defaultExpr} and load the default instead of NULL.`;
  } else {
    evidence.push("it has no default");
    suggestion = `If a sentinel value can stand for missing, declare ${input.type} DEFAULT <sentinel>; a Nullable column keeps a separate null mask.`;
  }
  return {
    type: `Nullable(${input.type})`,
    finding: {
      ruleId: "SQLRV003",
      severity: "warning",
      object: input.object,
      column: input.column,
      message: `Kept as Nullable(${input.type}) so no stored NULL is lost.`,
      evidence,
      suggestion,
      ...(input.at ? { at: input.at } : {}),
    },
  };
}

// --- LowCardinality -------------------------------------------------------

/** Last words of a column name that usually mean a small set of values. */
const LOW_CARDINALITY_WORDS = new Set("status state type kind category country currency region level channel gender lang language locale unit code flag method mode grade tier priority".split(" "));

/** A column name's last word: `order_status` and `OrderStatus` both give `status`. */
function lastWord(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  return (words[words.length - 1] ?? "").toLowerCase();
}

export interface LowCardinalityInput {
  object: string;
  column: string;
  /** The ClickHouse type as emitted. Only `String` and `Nullable(String)` are candidates. */
  type: string;
  /** The source's declared maximum length, when it has one. */
  maxLength?: number;
  at?: SourcePosition;
}

/** The longest declared length that still counts as supporting evidence. */
export const LOW_CARDINALITY_MAX_LENGTH = 50;

export function lowCardinalityReview(input: LowCardinalityInput): ReviewFinding | undefined {
  if (input.type !== "String" && input.type !== "Nullable(String)") return undefined;
  if (!LOW_CARDINALITY_WORDS.has(lastWord(input.column))) return undefined;
  const evidence = [`the name ${input.column} ends in a word that usually names a small set of values`, `the type is ${input.type}`];
  if (input.maxLength !== undefined && input.maxLength <= LOW_CARDINALITY_MAX_LENGTH) evidence.push(`the declared length is ${String(input.maxLength)}`);
  evidence.push("no data was read, so the distinct count is unknown");
  const wrapped = input.type.startsWith("Nullable(") ? "LowCardinality(Nullable(String))" : "LowCardinality(String)";
  return {
    ruleId: "SQLRV004",
    severity: "warning",
    object: input.object,
    column: input.column,
    message: `${input.column} is a LowCardinality candidate and stays ${input.type}.`,
    evidence,
    suggestion: `ClickHouse documents ${wrapped} as helpful below roughly ten thousand distinct values; count them with uniqExact(${q(input.column)}) before changing the type.`,
    ...(input.at ? { at: input.at } : {}),
  };
}

// --- constraints ----------------------------------------------------------

export interface ConstraintFact {
  kind: "foreign-key" | "check" | "unique";
  name?: string;
  columns?: readonly string[];
  references?: { table: string; columns: readonly string[] };
  /** A check's expression as the source wrote it. */
  expression?: string;
  at?: SourcePosition;
}

export interface ConstraintResult {
  /** `-- ` lines to put before the `CREATE`; never contain a line break. */
  comments: string[];
  findings: ReviewFinding[];
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export function constraintReview(input: { object: string; constraints: readonly ConstraintFact[] }): ConstraintResult {
  const comments: string[] = [];
  const findings: ReviewFinding[] = [];
  for (const c of input.constraints) {
    const label = c.name ? ` ${c.name}` : "";
    let text: string;
    let message: string;
    let suggestion: string;
    if (c.kind === "foreign-key") {
      const target = c.references ? `${c.references.table} (${list(c.references.columns)})` : "an unknown table";
      text = `FOREIGN KEY${label} (${list(c.columns ?? [])}) REFERENCES ${target}`;
      message = `Foreign key${label} is not enforced by ClickHouse and is kept as a comment.`;
      suggestion = "Check referential integrity in the load pipeline, or join on the column and accept orphan rows.";
    } else if (c.kind === "unique") {
      text = `UNIQUE${label} (${list(c.columns ?? [])})`;
      message = `Unique constraint${label} is not enforced by ClickHouse and is kept as a comment.`;
      suggestion = "A MergeTree sort key does not make rows unique. ReplacingMergeTree collapses duplicates on merge only.";
    } else {
      text = `CHECK${label} ${oneLine(c.expression ?? "")}`;
      message = `Check constraint${label} is not translated and is kept as a comment.`;
      suggestion = "ClickHouse has CONSTRAINT name CHECK expr, enforced on INSERT. Rewrite the expression in ClickHouse SQL to use it.";
    }
    comments.push(`-- ${oneLine(text)}`);
    findings.push({
      ruleId: "SQLRV005",
      severity: "warning",
      object: input.object,
      ...(c.kind !== "check" && c.columns && c.columns.length === 1 ? { column: c.columns[0]! } : {}),
      message,
      evidence: [oneLine(text)],
      suggestion,
      ...(c.at ? { at: c.at } : {}),
    });
  }
  return { comments, findings };
}
