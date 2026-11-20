/**
 * `@intentius/chant/report-store` (#5336): the schema ids of what the CI
 * products put in their report store, and one audit line for all of them.
 *
 * ## Schema ids
 *
 * Each document names its schema in `schema`. The product-neutral ids are
 * {@link REPORT_SCHEMAS}, `chant.<kind>/v1`, and a document under one names
 * its product in `product`. The ids the products wrote before,
 * `<product>.estate/v1`, `<product>.dora/v1`, `<product>.report/v1`,
 * `<product>.run/v1` and `<product>.audit/v1`, stay readable:
 * {@link readReportSchema} gives the kind and the product of either.
 * `ci-estate` writes the neutral ids when a product passes
 * `schemas: "neutral"`, and the product-named ids otherwise.
 *
 * The JSON Schemas are `@intentius/chant/report-store/<kind>.schema.json`
 * ({@link REPORT_SCHEMA_FILES}), so a reader such as behold validates every
 * product's files with chant installed and no product. The estate and DORA
 * schemas take a product-named id too; the audit schema is the neutral line,
 * and {@link readAuditLine} maps a product's line onto it.
 *
 * ## The audit line
 *
 * `chant.audit/v1` ({@link AuditLine}) is terragucci's `audit.jsonl` line
 * with the product and, for sql-yodeler's lines, the environment added. Its
 * `kind` is one of {@link AUDIT_KINDS}, the vocabulary's
 * `PRODUCT_AUDIT_KINDS` (`approved`, `applied`, ...), and a line read from a
 * product that spelled the kind another way keeps that word in
 * `product_kind`. Fields a product's line carries that the schema does not
 * name are kept in `product_fields`, so {@link toProductAuditLine} gives the
 * product's line back unchanged.
 *
 * {@link auditLinesFromLedger} builds the lines from the gate ledger
 * (`deriveGateAudit`, ./lifecycle/gate-audit.ts) for any product, and
 * {@link writeAuditRecord} appends them to `audit.jsonl` in the report store,
 * keeping every line the record holds, in whatever format it was written.
 */
import { PRODUCT_AUDIT_KINDS } from "./ci-product-words";
import type { GateAuditEntry } from "./lifecycle/gate-audit";
import type { ReportGet, ReportPut } from "./pr-report-url";
import { NEXT_RELEASE } from "./release-floors";

/** The first chant with `@intentius/chant/report-store`: the product-neutral schema ids, the `chant.audit/v1` line and its readers, the published schemas, and `ci-estate`'s `schemas: "neutral"` and promote and rollback counts (#5336). */
export const REPORT_STORE_FLOOR = NEXT_RELEASE;

/** The kinds of document in the report store. A run report is a stage's report or a commit's run view. */
export type ReportKind = "estate" | "dora" | "run" | "audit";

/** The product-neutral schema ids. */
export const REPORT_SCHEMAS = /* @__PURE__ */ Object.freeze({
  estate: "chant.estate/v1",
  dora: "chant.dora/v1",
  run: "chant.run/v1",
  audit: "chant.audit/v1",
} as const satisfies Record<ReportKind, string>);

/** The published JSON Schema of each kind, as a package path. */
export const REPORT_SCHEMA_FILES = /* @__PURE__ */ Object.freeze({
  estate: "@intentius/chant/report-store/estate.schema.json",
  dora: "@intentius/chant/report-store/dora.schema.json",
  run: "@intentius/chant/report-store/run.schema.json",
  audit: "@intentius/chant/report-store/audit.schema.json",
} as const satisfies Record<ReportKind, string>);

/** The prefix of the neutral ids. */
const NEUTRAL = "chant";

/** The word after the product in a product-named id, by kind: terragucci's stage report is `report`, its run view `run`. */
const ID_WORDS: Readonly<Record<string, ReportKind>> = { estate: "estate", dora: "dora", report: "run", run: "run", audit: "audit" };

const ID_RE = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)\/v1$/;

export interface ReportSchema {
  kind: ReportKind;
  /** The product a product-named id names; undefined for a neutral id, whose document names it in `product`. */
  product?: string;
  neutral: boolean;
}

/** The kind of a schema id, neutral or product-named, or undefined for an id the report store does not hold. */
export function readReportSchema(id: unknown): ReportSchema | undefined {
  if (typeof id !== "string") return undefined;
  const m = ID_RE.exec(id);
  if (!m) return undefined;
  const kind = ID_WORDS[m[2]!];
  if (!kind) return undefined;
  if (m[1] === NEUTRAL) return { kind, neutral: true };
  return { kind, product: m[1]!, neutral: false };
}

/** The product a document came from: its `product`, else the product its schema id names. */
export function reportProduct(doc: { schema?: unknown; product?: unknown }): string | undefined {
  if (typeof doc.product === "string" && doc.product !== "") return doc.product;
  const s = readReportSchema(doc.schema);
  if (!s) return undefined;
  return s.product ?? NEUTRAL;
}

/** Which ids a writer uses: the product's own (`<product>.dora/v1`), or the neutral ones with `product`. */
export type ReportSchemaIds = "product" | "neutral";

/** `doc` under the neutral id of `kind`, with `product` after `schema`. */
export function neutralReport<T extends { schema: string }>(doc: T, kind: ReportKind, product: string): T & { product: string } {
  const { schema: _schema, product: _product, ...rest } = doc as T & { product?: unknown };
  return { schema: REPORT_SCHEMAS[kind], product, ...rest } as unknown as T & { product: string };
}

// ── the audit line ───────────────────────────────────────────────────────

export const AUDIT_KINDS = [
  "approval-requested",
  "approved",
  "revoked",
  "override-requested",
  "override-recorded",
  "override-spent",
  "applied",
  "refused",
  "hook",
  "recorded",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** Where a line was read: a ledger line, a report in the store, a state's versions, a history row, or a run record. */
export interface AuditEvidence {
  source: "ledger" | "report" | "state" | "history" | "run";
  /** Ledger: the branch, the file, the op and gate, the line and the commit. */
  branch?: string;
  path?: string;
  op?: string;
  gate?: string;
  line?: number;
  commit?: string;
  /** Report: the bucket and the key of the report. */
  bucket?: string;
  key?: string;
  /** A page that shows it. */
  url?: string;
  job_url?: string;
  /** Report: deleted after the line was recorded. */
  deleted?: boolean;
  /** State: where the state is, and the version its store lists. */
  location?: string;
  version_id?: string;
  /** History: the table, the row's seq and its run. */
  table?: string;
  seq?: number;
  run?: string;
}

/** One line of `audit.jsonl`, `chant.audit/v1`. */
export interface AuditLine {
  schema: typeof REPORT_SCHEMAS.audit;
  /** The product that recorded it. */
  product: string;
  /** Over where the line came from; the same records give the same id. */
  id: string;
  kind: AuditKind;
  /** The product's own word for the kind, when it is not `kind`. */
  product_kind?: string;
  /** The repository or member. */
  project: string;
  /** The environment, when the product records one per line. */
  environment?: string;
  at: string;
  /** Who: the approver, the overrider, whoever removed the line, or whoever ran it. Null when nobody did. */
  who: string | null;
  /** The gate, the root, or the migration. */
  what: string;
  digest: string | null;
  /** How it came out: `waiting`, `applied`, `failed`, the seal of an approval, ... */
  result: string;
  evidence: AuditEvidence;
  detail?: Record<string, unknown>;
  /** Top-level fields of a product's line the schema does not name. */
  product_fields?: Record<string, unknown>;
}

/** A product's line format: terragucci's (`<product>.audit/v1`), or sql-yodeler's (no `schema`, one `environment` per line). */
export type ProductAuditFormat = "terragucci" | "sql-yodeler";

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const KIND_OF: ReadonlyMap<string, AuditKind> = new Map(
  (Object.entries(PRODUCT_AUDIT_KINDS) as [AuditKind, readonly string[]][]).flatMap(([kind, aliases]) => [[kind, kind] as const, ...aliases.map((a) => [a, kind] as const)]),
);

/** The audit kind a product's word names: the kind itself, an alias of one, or `recorded`. */
export function auditKindOf(word: string): AuditKind {
  return KIND_OF.get(word) ?? "recorded";
}

const TERRAGUCCI_FIELDS = new Set(["schema", "id", "kind", "project", "at", "who", "what", "digest", "result", "evidence", "detail"]);
const YODELER_FIELDS = new Set(["id", "at", "environment", "kind", "by", "migration", "digest", "detail", "wave", "source"]);

const rest = (row: Row, known: ReadonlySet<string>): Record<string, unknown> | undefined => {
  const out = Object.fromEntries(Object.entries(row).filter(([k]) => !known.has(k)));
  return Object.keys(out).length ? out : undefined;
};

function fromTerragucci(row: Row, product: string): AuditLine | undefined {
  const id = str(row.id);
  const word = str(row.kind);
  if (!id || !word || !isRow(row.evidence)) return undefined;
  const kind = auditKindOf(word);
  const extra = rest(row, TERRAGUCCI_FIELDS);
  return {
    schema: REPORT_SCHEMAS.audit,
    product,
    id,
    kind,
    ...(kind !== word ? { product_kind: word } : {}),
    project: str(row.project) ?? "",
    at: str(row.at) ?? "",
    who: str(row.who) ?? null,
    what: str(row.what) ?? "",
    digest: str(row.digest) ?? null,
    result: str(row.result) ?? "",
    evidence: row.evidence as unknown as AuditEvidence,
    ...(isRow(row.detail) ? { detail: row.detail } : {}),
    ...(extra ? { product_fields: extra } : {}),
  };
}

/** sql-yodeler's `result` for each of its kinds: a wait, or the kind's own word. */
const yodelerResult = (word: string): string => (word === "approval-requested" ? "waiting" : word);

function fromYodeler(row: Row, product: string, project: string): AuditLine | undefined {
  const id = str(row.id);
  const word = str(row.kind);
  const environment = str(row.environment);
  const source = row.source;
  if (!id || !word || environment === undefined || !isRow(source)) return undefined;
  // A failed migration row is an apply that failed.
  const kind = word === "failed" ? "applied" : auditKindOf(word);
  const evidence: AuditEvidence =
    typeof source.history === "string"
      ? { source: "history", table: source.history, ...(typeof source.seq === "number" ? { seq: source.seq } : {}), ...(typeof source.run === "string" ? { run: source.run } : {}) }
      : { source: "ledger", ...(typeof source.ledger === "string" ? { path: source.ledger } : {}), ...(typeof source.op === "string" ? { op: source.op } : {}), ...(typeof source.gate === "string" ? { gate: source.gate } : {}) };
  const migration = str(row.migration);
  const detail = {
    ...(migration !== undefined ? { migration } : {}),
    ...(row.detail !== undefined ? { text: row.detail } : {}),
    ...(row.wave !== undefined ? { wave: row.wave } : {}),
  };
  const extra = rest(row, YODELER_FIELDS);
  return {
    schema: REPORT_SCHEMAS.audit,
    product,
    id,
    kind,
    ...(kind !== word ? { product_kind: word } : {}),
    project,
    environment,
    at: str(row.at) ?? "",
    who: str(row.by) ?? null,
    what: migration ?? str(source.gate) ?? environment,
    digest: str(row.digest) ?? null,
    result: yodelerResult(word),
    evidence,
    ...(Object.keys(detail).length ? { detail } : {}),
    ...(extra ? { product_fields: extra } : {}),
  };
}

export interface ReadAuditOptions {
  /** The product of a line whose format does not name one (sql-yodeler's). Default `sql-yodeler`. */
  product?: string;
  /** The project of a line that names none (sql-yodeler's). Default `default`. */
  project?: string;
}

/**
 * One audit line as `chant.audit/v1`: a neutral line as it is, a
 * terragucci-format line (`<product>.audit/v1`) or a sql-yodeler line
 * mapped onto it. Undefined for anything else.
 */
export function readAuditLine(raw: unknown, options: ReadAuditOptions = {}): AuditLine | undefined {
  if (!isRow(raw)) return undefined;
  const schema = readReportSchema(raw.schema);
  if (schema?.kind === "audit" && schema.neutral) {
    return typeof raw.id === "string" && typeof raw.product === "string" && (AUDIT_KINDS as readonly unknown[]).includes(raw.kind) ? (raw as unknown as AuditLine) : undefined;
  }
  if (schema?.kind === "audit") return fromTerragucci(raw, schema.product!);
  if (raw.schema === undefined) return fromYodeler(raw, options.product ?? "sql-yodeler", options.project ?? "default");
  return undefined;
}

/** Every line of an `audit.jsonl` as `chant.audit/v1`, and the 1-based numbers of the lines that are not audit lines. */
export function readAuditRecord(text: string, options: ReadAuditOptions = {}): { lines: AuditLine[]; unreadable: number[] } {
  const lines: AuditLine[] = [];
  const unreadable: number[] = [];
  text.split("\n").forEach((t, i) => {
    if (t.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      unreadable.push(i + 1);
      return;
    }
    const line = readAuditLine(v, options);
    if (line) lines.push(line);
    else unreadable.push(i + 1);
  });
  return { lines, unreadable };
}

/**
 * A line in a product's own format again, for a product that keeps writing
 * it: a line read from that format comes back as it was read.
 */
export function toProductAuditLine(line: AuditLine, format: ProductAuditFormat): Record<string, unknown> {
  const kind = line.product_kind ?? line.kind;
  if (format === "terragucci") {
    return {
      schema: `${line.product}.audit/v1`,
      id: line.id,
      kind,
      project: line.project,
      at: line.at,
      who: line.who,
      what: line.what,
      digest: line.digest,
      result: line.result,
      evidence: line.evidence,
      ...(line.detail ? { detail: line.detail } : {}),
      ...line.product_fields,
    };
  }
  const d = line.detail ?? {};
  const e = line.evidence;
  const source =
    e.source === "history"
      ? { history: e.table, ...(e.seq !== undefined ? { seq: e.seq } : {}), ...(e.run !== undefined ? { run: e.run } : {}) }
      : { ...(e.path !== undefined ? { ledger: e.path } : {}), ...(e.op !== undefined ? { op: e.op } : {}), ...(e.gate !== undefined ? { gate: e.gate } : {}) };
  return {
    id: line.id,
    at: line.at,
    environment: line.environment ?? "",
    kind,
    ...(line.who !== null ? { by: line.who } : {}),
    ...(typeof d.migration === "string" ? { migration: d.migration } : {}),
    ...(line.digest !== null ? { digest: line.digest } : {}),
    ...(d.text !== undefined ? { detail: d.text } : {}),
    ...(d.wave !== undefined ? { wave: d.wave } : {}),
    source,
    ...line.product_fields,
  };
}

// ── from the ledger ──────────────────────────────────────────────────────

/** How a gate entry came out, as the line's `result`. */
function resultOf(e: GateAuditEntry): string {
  switch (e.kind) {
    case "approval-requested":
      return "waiting";
    case "override-requested":
      return "denied";
    case "approved":
    case "override-recorded":
      return e.seal ?? "unsigned";
    case "revoked":
      return "revoked";
    case "applied":
      return typeof e.detail.result === "string" ? e.detail.result : "applied";
    case "override-spent":
      return "spent";
    case "hook":
      return e.hook?.outcome ?? "ran";
  }
}

const ENTRY_FIELDS = new Set(["id", "kind", "at", "gate", "digest", "by", "detail", "source"]);

export interface LedgerAuditOptions {
  /** The product that records the lines. */
  product: string;
  /** The repository or member the ledger belongs to. */
  project: string;
  /** The environment, when the ledger is one environment's. */
  environment?: string;
  /** The ledger's branch, for the evidence. Default `chant/lifecycle`. */
  branch?: string;
}

/** The audit lines of the gate ledger's entries (`deriveGateAudit`), for any product. */
export function auditLinesFromLedger(entries: readonly GateAuditEntry[], options: LedgerAuditOptions): AuditLine[] {
  return entries.map((e) => {
    const s = e.source;
    const ledger = s.change === "added" || s.change === "removed";
    const evidence: AuditEvidence = ledger
      ? { source: "ledger", branch: options.branch ?? "chant/lifecycle", path: s.path, ...(s.op ? { op: s.op } : {}), gate: e.gate, ...(s.line !== undefined ? { line: s.line } : {}), ...(s.commit ? { commit: s.commit } : {}) }
      : { source: s.change === "decision" ? "run" : "report", key: s.path, gate: e.gate, ...(s.commit ? { commit: s.commit } : {}) };
    const typed = Object.fromEntries(Object.entries(e).filter(([k, v]) => !ENTRY_FIELDS.has(k) && v !== undefined));
    const detail = { ...e.detail, ...typed };
    return {
      schema: REPORT_SCHEMAS.audit,
      product: options.product,
      id: e.id,
      kind: e.kind,
      project: options.project,
      ...(options.environment ? { environment: options.environment } : {}),
      at: e.at,
      who: e.by ?? null,
      what: e.gate,
      digest: e.digest ?? null,
      result: resultOf(e),
      evidence,
      ...(Object.keys(detail).length ? { detail } : {}),
    };
  });
}

// ── the record in the store ──────────────────────────────────────────────

/** The record's name at the top of a reports prefix. */
export const AUDIT_RECORD_FILE = "audit.jsonl";

export interface WriteAuditOptions {
  put: ReportPut;
  get: ReportGet;
  /** The key below the report URL. Default `audit.jsonl`. */
  key?: string;
}

/**
 * Append the lines whose id the record lacks to `audit.jsonl` in the report
 * store. Every line already there is kept as it is, whatever its format;
 * nothing is written when nothing is new.
 */
export async function writeAuditRecord(lines: readonly AuditLine[], options: WriteAuditOptions): Promise<{ key: string; added: number }> {
  const key = options.key ?? AUDIT_RECORD_FILE;
  const before = (await options.get(key)) ?? "";
  const have = new Set<string>();
  for (const t of before.split("\n")) {
    if (t.trim() === "") continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (isRow(v) && typeof v.id === "string") have.add(v.id);
    } catch {
      // A line that is not JSON stays in the record and holds no id.
    }
  }
  const fresh: AuditLine[] = [];
  for (const l of lines) {
    if (have.has(l.id)) continue;
    have.add(l.id);
    fresh.push(l);
  }
  if (fresh.length === 0) return { key, added: 0 };
  const head = before === "" || before.endsWith("\n") ? before : `${before}\n`;
  await options.put(key, head + fresh.map((l) => `${JSON.stringify(l)}\n`).join(""), "application/x-ndjson");
  return { key, added: fresh.length };
}
