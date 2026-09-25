/**
 * `chant workspace records new|amend|review` (#2670): the commands a UI
 * writes records through, so it never parses or writes a record file itself
 * (ws-052).
 *
 * Each command loads the kind, reads every record it locates, builds the one
 * file it would write, and reads the records again with that file in place,
 * through the same {@link readRecords} a read uses. The write goes ahead only
 * when the written record comes back valid and no other record gains a
 * reason. So a write is refused for exactly what a later read would report,
 * plus the rules only a write has: ids are allocated and never reused, a
 * closed record never changes, an approved one changes only in place of
 * what the approval rule allows, and a dissent needs a note.
 *
 * Every command writes one file or none, never commits, and prints one JSON
 * document with a closed error code on refusal. `--dry-run` prints the
 * document and the text it would write, and writes nothing.
 *
 * `new --sign` and `amend --sign` seal the record's author (#2688), and
 * `review --sign` seals a verdict (#2687): see `trust/seal.ts`.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import type { CommandContext } from "../cli/registry";
import type { ReasonCode } from "./reason-codes";
import { gitRoot, workingTreeSource, type RecordSource } from "./record-source";
import {
  loadRecordKind,
  parseFrontMatter,
  readRecords,
  RECORD_REASON_CODES,
  RecordReadError,
  RECORD_SEAL_FIELD,
  digestFields,
  recordTextDigest,
  type LoadedRecordKind,
  type RecordEntry,
  type RecordWarning,
} from "./records";
import { declaredKindFiles, pinRoot, realpathOr } from "./records-cli";
import { WorkspaceReadError } from "./declaration";
import { workingTree } from "./tree";

// ── Contract ─────────────────────────────────────────────────────────────────

/** The version of the write documents this chant prints. */
export const RECORDS_WRITE_CONTRACT_VERSION = 1;

export const RECORDS_NEW_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/records-new/v1/records-new.schema.json";
export const RECORDS_AMEND_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/records-amend/v1/records-amend.schema.json";
export const RECORDS_REVIEW_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/records-review/v1/records-review.schema.json";

/** Loading the kind and reading its records, as `records` reads them. */
const LOAD_ERROR_CODES = ["kind-unreadable", "kind-invalid", "schema-unreadable", "schema-id-mismatch", "schema-invalid", "location-missing"] as const;

/** Why `records new` wrote nothing. Closed: a reader may switch on it. */
export const NEW_ERROR_CODES = [
  ...LOAD_ERROR_CODES,
  "write-usage-invalid",
  "write-input-invalid",
  "record-id-taken",
  "record-id-unallocatable",
  "record-path-unmatched",
  "record-sign-failed",
  ...RECORD_REASON_CODES,
] as const satisfies readonly ReasonCode[];

/** Why `records amend` wrote nothing. */
export const AMEND_ERROR_CODES = [
  ...LOAD_ERROR_CODES,
  "write-usage-invalid",
  "write-input-invalid",
  "record-not-found",
  "amend-id-immutable",
  "record-closed",
  "amend-supersede-instead",
  "record-sign-failed",
  ...RECORD_REASON_CODES,
] as const satisfies readonly ReasonCode[];

/** Why `records review` wrote nothing. */
export const REVIEW_ERROR_CODES = [
  ...LOAD_ERROR_CODES,
  "write-usage-invalid",
  "record-not-found",
  "review-unsupported",
  "record-closed",
  "review-note-required",
  "review-sign-failed",
  ...RECORD_REASON_CODES,
] as const satisfies readonly ReasonCode[];

export type NewErrorCode = (typeof NEW_ERROR_CODES)[number];
export type AmendErrorCode = (typeof AMEND_ERROR_CODES)[number];
export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];
type WriteErrorCode = NewErrorCode | AmendErrorCode | ReviewErrorCode;

export const VERDICTS = ["agree", "dissent", "abstain"] as const;
export type Verdict = (typeof VERDICTS)[number];

class RecordWriteError extends Error {
  constructor(
    readonly code: WriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecordWriteError";
  }
}

interface KindView {
  name: string;
  schema: string;
  file: string;
}

/** What every write result carries. */
interface WriteResult {
  $schema: string;
  contract: number;
  kind: KindView;
  /** The record file, from the repository root (the working directory outside git), with / separators. */
  path: string;
  id: string;
  /** True when nothing was written. */
  dryRun: boolean;
  /** The written record's warnings, as `records` would report them. */
  warnings: RecordWarning[];
  /** With --dry-run, the whole text the command would write. */
  text?: string;
}

interface WriteFailure<C> {
  $schema: string;
  contract: number;
  error: { code: C; message: string };
}

/** A record's author seal as `new` and `amend` write it with `--sign` (#2688). */
export interface AuthorSeal {
  signer: string;
  key: string;
  signature: string;
}

export type NewDocument = (WriteResult & { seal?: AuthorSeal }) | WriteFailure<NewErrorCode>;
export type AmendDocument = (WriteResult & { changed: string[]; seal?: AuthorSeal; sealDropped?: string }) | WriteFailure<AmendErrorCode>;
export type ReviewDocument = (WriteResult & { review: Record<string, unknown> }) | WriteFailure<ReviewErrorCode>;

// ── Rendering ────────────────────────────────────────────────────────────────

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_KEY = new Set(["true", "false", "null"]);

function yamlKey(k: string): string {
  return PLAIN_KEY.test(k) && !RESERVED_KEY.has(k) ? k : JSON.stringify(k);
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

function isEmpty(v: unknown): boolean {
  return Array.isArray(v) ? v.length === 0 : v !== null && typeof v === "object" && Object.keys(v).length === 0;
}

const scalar = (v: unknown): string => (v === null ? "null" : JSON.stringify(v));
const empty = (v: unknown): string => (Array.isArray(v) ? "[]" : "{}");

/**
 * YAML limited to what JSON can say, laid out as the decision README writes a
 * record: every string double-quoted with JSON escapes, block mappings and
 * sequences, and `[]` or `{}` for an empty one. `parseFrontMatter` reads it
 * back to the same value.
 */
export function toYaml(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${scalar(item)}`;
        if (isEmpty(item)) return `${pad}- ${empty(item)}`;
        if (Array.isArray(item)) return `${pad}-\n${toYaml(item, indent + 2)}`;
        return `${pad}- ${toYaml(item, indent + 2).slice(indent + 2)}`;
      })
      .join("\n");
  }
  if (isScalar(value)) return `${pad}${scalar(value)}`;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isScalar(v)) lines.push(`${pad}${yamlKey(k)}: ${scalar(v)}`);
    else if (isEmpty(v)) lines.push(`${pad}${yamlKey(k)}: ${empty(v)}`);
    else lines.push(`${pad}${yamlKey(k)}:\n${toYaml(v, indent + 2)}`);
  }
  return lines.join("\n");
}

/** A record file: the front matter, then `body` as it is. */
export function renderRecord(data: Record<string, unknown>, body: string): string {
  return `---\n${toYaml(data)}\n---\n${body}`;
}

/** The text below a file's front matter, line endings normalised. */
function bodyOf(text: string): string {
  const normalised = text.replace(/\r\n?/g, "\n");
  const m = normalised.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  return m ? normalised.slice(m[0].length) : "";
}

/** JSON with object keys sorted, for comparing two values whatever their key order. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

/**
 * `text` with the top-level fields in `set` replaced in place, and every
 * other byte kept. A field's block is its key line at column 0 and the lines
 * after it, up to the closing `---`, that start with a space, a tab, `#` or
 * `-`: the block {@link recordTextDigest} cuts for the reviews field. Blank
 * lines ending a block stay where they are. A field the front matter lacks is
 * added before the closing `---`. Line endings become LF. Returns undefined
 * when the text has no front matter, or when the result does not read back
 * as `expected`, so a caller never writes a file it did not mean to.
 */
export function replaceFields(text: string, set: Record<string, unknown>, expected: Record<string, unknown>): string | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") return undefined;
  let close = lines.indexOf("---", 1);
  if (close < 0) return undefined;
  for (const [key, value] of Object.entries(set)) {
    const rendered = toYaml({ [key]: value }).split("\n");
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const starts = new RegExp(`^(?:${k}|"${k}"|'${k}')[ \\t]*:(?:[ \\t]|$)`);
    const at = lines.findIndex((l, i) => i > 0 && i < close && starts.test(l));
    if (at < 0) {
      lines.splice(close, 0, ...rendered);
      close += rendered.length;
      continue;
    }
    let end = at;
    while (end + 1 < close && /^(?:$|[ \t#-])/.test(lines[end + 1])) end++;
    while (end > at && lines[end] === "") end--;
    lines.splice(at, end - at + 1, ...rendered);
    close += rendered.length - (end - at + 1);
  }
  const out = lines.join("\n");
  const back = parseFrontMatter(out);
  return back.ok && stableJson(back.value) === stableJson(expected) ? out : undefined;
}

/**
 * `text` with the top-level field `key` removed: its key line and the lines
 * after it that {@link replaceFields} counts as its block, less the blank
 * lines ending it, which stay. Returns undefined when the result does not
 * read back as `expected`.
 */
export function removeField(text: string, key: string, expected: Record<string, unknown>): string | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") return undefined;
  const close = lines.indexOf("---", 1);
  if (close < 0) return undefined;
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const starts = new RegExp(`^(?:${k}|"${k}"|'${k}')[ \\t]*:(?:[ \\t]|$)`);
  const at = lines.findIndex((l, i) => i > 0 && i < close && starts.test(l));
  if (at >= 0) {
    let end = at;
    while (end + 1 < close && /^(?:$|[ \t#-])/.test(lines[end + 1])) end++;
    while (end > at && lines[end] === "") end--;
    lines.splice(at, end - at + 1);
  }
  const out = lines.join("\n");
  const back = parseFrontMatter(out);
  return back.ok && stableJson(back.value) === stableJson(expected) ? out : undefined;
}

/** A file-name slug from a title, as `scripts/import-decisions.mjs` makes one. */
export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/, "");
}

// ── Shared steps ─────────────────────────────────────────────────────────────

interface Opened {
  loaded: LoadedRecordKind;
  root: string;
  /** Where pinned paths resolve, from `root`. */
  workspaceRoot: string;
  source: RecordSource;
  view: KindView;
  /** The records directory, from `root`. */
  dirRel: string;
}

async function open(kind: string, cwd: string): Promise<Opened> {
  const real = realpathOr(cwd);
  const root = gitRoot(real) ?? real;
  const loaded = await loadRecordKind(kind, real);
  // The writers write Markdown front matter with an id field. A JSON or
  // content-addressed kind (ws-053) is read by records, and written by its own tool.
  if (loaded.kind.format !== "markdown-front-matter" || loaded.kind.idField === undefined) {
    const what = loaded.kind.format !== "markdown-front-matter" ? `format ${loaded.kind.format}` : `ids from ${loaded.kind.idFrom}`;
    throw new RecordWriteError("write-usage-invalid", `the ${loaded.kind.name} kind has ${what}, and records new, amend and review write only Markdown front matter records with an idField`);
  }
  const dirRel = relative(root, loaded.dir).split("\\").join("/") || ".";
  return {
    loaded,
    root,
    workspaceRoot: pinRoot(loaded.file, root),
    source: workingTreeSource(root),
    view: { name: loaded.kind.name, schema: loaded.kind.schema.id, file: relative(root, loaded.file).split("\\").join("/") },
    dirRel,
  };
}

async function readAll(o: Opened, source: RecordSource): Promise<RecordEntry[]> {
  const assets = workingTree(o.workspaceRoot === "." ? o.root : join(o.root, ...o.workspaceRoot.split("/")));
  return (await readRecords(o.loaded, { root: o.root, source, assets })).records;
}

/** `base` with the file at `path` holding `text`, added to its directory when new. */
function overlay(base: RecordSource, path: string, text: string): RecordSource {
  const dir = posix.dirname(path);
  const name = posix.basename(path);
  return {
    label: base.label,
    list(d) {
      const names = base.list(d);
      if (d !== dir || !names) return names;
      return names.includes(name) ? names : [...names, name];
    },
    read(p) {
      return p === path ? text : base.read(p);
    },
    bytes(p) {
      return p === path ? Buffer.from(text, "utf-8") : base.bytes(p);
    },
  };
}

/**
 * Read the records again with `text` at `path`. The written record must come
 * back with no reason, and no other record may gain one. Returns the written
 * record's warnings.
 */
async function validateWrite(o: Opened, before: RecordEntry[], path: string, text: string): Promise<RecordWarning[]> {
  const after = await readAll(o, overlay(o.source, path, text));
  const written = after.find((e) => e.path === path);
  if (!written) throw new RecordWriteError("record-path-unmatched", `${path} is not a file the kind ${o.view.name} reads`);
  if (written.reasons.length > 0) {
    throw new RecordWriteError(written.reasons[0].code, written.reasons.map((r) => `${r.code}: ${r.message}`).join("; "));
  }
  const had = new Map(before.map((e) => [e.path, new Set(e.reasons.map((r) => `${r.code}\0${r.message}`))]));
  for (const e of after) {
    if (e.path === path) continue;
    const gained = e.reasons.find((r) => !had.get(e.path)?.has(`${r.code}\0${r.message}`));
    if (gained) throw new RecordWriteError(gained.code, `writing ${path} would make ${e.path} invalid: ${gained.message}`);
  }
  return written.warnings;
}

function findRecord(entries: RecordEntry[], id: string, kind: string): RecordEntry & { data: Record<string, unknown> } {
  const hits = entries.filter((e) => e.id === id);
  if (hits.length === 0) throw new RecordWriteError("record-not-found", `no ${kind} record has id ${id}`);
  if (hits.length > 1) {
    throw new RecordWriteError("record-id-duplicate", `id ${id} is used by ${hits.map((h) => h.path).join(" and ")}; make the ids unique before writing either`);
  }
  return hits[0] as RecordEntry & { data: Record<string, unknown> };
}

function parseFields(text: string, flag: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new RecordWriteError("write-input-invalid", `the fields given with ${flag} are not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RecordWriteError("write-input-invalid", `the fields given with ${flag} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Refuse fields that set the author seal by hand: only --sign writes it (#2688). */
function refuseSealField(o: Opened, fields: Record<string, unknown>, flag: string): void {
  if (o.loaded.kind.reviews && RECORD_SEAL_FIELD in fields) {
    throw new RecordWriteError("write-input-invalid", `the fields given with ${flag} set ${RECORD_SEAL_FIELD}, and only --sign writes a record's seal`);
  }
}

/**
 * `text`, the record `data` holds, with its author sealed (#2688): an ssh
 * signature by the key `sign` names over the record id, the digest of
 * `text`, the author (the kind's `reviews.decider` field) and the state, in
 * the `chant-record` namespace. The seal goes in the top-level `seal` field,
 * replacing one already there, or added at the end of the front matter. The
 * digest leaves that field out, so it is the same before and after.
 */
async function sealAuthor(o: Opened, text: string, data: Record<string, unknown>, id: string, sign: string | true, cwd: string): Promise<{ text: string; seal: AuthorSeal }> {
  const { kind } = o.loaded;
  if (!kind.reviews) {
    throw new RecordWriteError(
      "write-usage-invalid",
      `--sign seals a record's author, named by the kind's reviews.decider field, and the ${kind.name} kind declares no reviews`,
    );
  }
  const field = kind.reviews.decider;
  const author = data[field];
  if (typeof author !== "string" || author.trim() === "") {
    throw new RecordWriteError("record-sign-failed", `${id} names no ${field}, so there is no author to seal: set ${field}, then seal it with records amend ${id} --sign`);
  }
  const state = kind.stateField !== undefined && typeof data[kind.stateField] === "string" ? (data[kind.stateField] as string) : null;
  const digest = recordTextDigest(text, digestFields(kind), kind.format);
  const { resolveSigningKey, sealRecord, SealError } = await import("./trust/seal");
  let seal: AuthorSeal;
  try {
    const key = resolveSigningKey(sign, cwd);
    try {
      seal = { ...sealRecord(key.file, { record: id, digest, author, state }) };
    } finally {
      key.cleanup();
    }
  } catch (err) {
    if (err instanceof SealError) throw new RecordWriteError("record-sign-failed", err.message);
    throw err;
  }
  const sealed = replaceFields(text, { [RECORD_SEAL_FIELD]: seal }, { ...data, [RECORD_SEAL_FIELD]: seal });
  if (sealed === undefined) throw new RecordWriteError("record-unparseable", `the ${RECORD_SEAL_FIELD} field can't be written into ${id} without changing the rest of the file`);
  if (recordTextDigest(sealed, digestFields(kind), kind.format) !== digest) {
    throw new Error(`sealing ${id} moved its digest; the seal block and the digest rule disagree`);
  }
  return { text: sealed, seal };
}

/** Keys in the schema's `required` order, then its `properties` order, then the rest as given. */
function schemaOrder(data: Record<string, unknown>, schema: Record<string, unknown>): string[] {
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === "string") : [];
  const props = schema.properties !== null && typeof schema.properties === "object" ? Object.keys(schema.properties as object) : [];
  const order = [...new Set([...required, ...props])];
  const keys = Object.keys(data);
  return [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k))];
}

function pick(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, data[k]]));
}

function abs(o: Opened, path: string): string {
  return join(o.root, ...path.split("/"));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function failure<C>(schema: string, err: unknown): WriteFailure<C> {
  if (err instanceof RecordWriteError || err instanceof RecordReadError) {
    return { $schema: schema, contract: RECORDS_WRITE_CONTRACT_VERSION, error: { code: err.code as C, message: err.message } };
  }
  throw err;
}

// ── records new ──────────────────────────────────────────────────────────────

const ALLOCATABLE = /^([A-Za-z][A-Za-z0-9]*)-([0-9]+)$/;

/**
 * The next id: `<prefix>-<n>`, one above the highest number any record in the
 * directory has with that prefix, padded to at least three digits, or to the
 * widest number those records use. Ids come from the records' own id field
 * and, for a file that can't be read, from its name, so an id in use is never
 * handed out again. The shape is derived from the records, with the prefix's
 * case kept: a work kind's `W-001` and `W-002` give `W-003` (#2683), and a
 * decision's `ws-052` gives `ws-053`. The kind's schema still judges the id
 * written. Without `prefix`, every record must share one prefix.
 */
export function allocateId(entries: RecordEntry[], prefix: string | undefined, kind: string): string {
  const seen: Array<{ prefix: string; digits: string }> = [];
  for (const e of entries) {
    const stem = e.id ?? posix.basename(e.path).match(/^([A-Za-z][A-Za-z0-9]*-[0-9]+)/)?.[1] ?? null;
    const m = stem?.match(ALLOCATABLE);
    if (m) seen.push({ prefix: m[1], digits: m[2] });
  }
  if (prefix === undefined) {
    const prefixes = [...new Set(seen.map((s) => s.prefix))];
    if (prefixes.length !== 1) {
      throw new RecordWriteError(
        "record-id-unallocatable",
        prefixes.length === 0
          ? `no ${kind} record has an id of the form <prefix>-<number> to follow; pass --prefix <prefix>, or give the id in the fields`
          : `the ${kind} records use the prefixes ${prefixes.join(", ")}; pass --prefix with one of them, or give the id in the fields`,
      );
    }
    prefix = prefixes[0];
  }
  const mine = seen.filter((s) => s.prefix === prefix);
  const max = mine.reduce((m, s) => Math.max(m, Number(s.digits)), 0);
  const width = Math.max(3, ...mine.map((s) => s.digits.length));
  return `${prefix}-${String(max + 1).padStart(width, "0")}`;
}

export interface NewRecordOptions {
  /** The kind file, resolved against `cwd`. */
  kind: string;
  /** The record's fields, as JSON text. */
  fields: string;
  /** The id prefix to allocate under, when the fields hold no id. */
  prefix?: string;
  dryRun?: boolean;
  cwd: string;
  /**
   * Seal the record's author (#2688): a key file, resolved against `cwd`, or
   * true for git's `user.signingkey`. The author is the kind's
   * `reviews.decider` field, which the fields must set.
   */
  sign?: string | true;
}

/** `records new`: write one new record from validated fields, sealed by its author with `sign`. */
export async function newRecord(opts: NewRecordOptions): Promise<NewDocument> {
  try {
    if (opts.prefix !== undefined && !/^[A-Za-z][A-Za-z0-9]*$/.test(opts.prefix)) {
      throw new RecordWriteError("write-usage-invalid", `--prefix takes letters and digits, starting with a letter, not ${JSON.stringify(opts.prefix)}`);
    }
    const fields = parseFields(opts.fields, "--from");
    const o = await open(opts.kind, opts.cwd);
    const { kind, schema } = o.loaded;
    refuseSealField(o, fields, "--from");
    const idField = kind.idField!;
    const before = await readAll(o, o.source);
    const given = fields[idField];
    let id: string;
    if (given === undefined) {
      id = allocateId(before, opts.prefix, kind.name);
    } else {
      if (typeof given !== "string" || given === "") throw new RecordWriteError("write-input-invalid", `${idField} must be a non-empty string when it is given`);
      const taken = before.find((e) => e.id === given || posix.basename(e.path).startsWith(`${given}-`) || posix.basename(e.path) === `${given}.md`);
      if (taken) throw new RecordWriteError("record-id-taken", `id ${given} is already used by ${taken.path}; ids are never reused, so leave ${idField} out to have the next one allocated`);
      id = given;
    }
    const data = pick({ ...fields, [idField]: id }, schemaOrder({ ...fields, [idField]: id }, schema));
    const title = typeof data.title === "string" ? data.title : "";
    const match = new RegExp(kind.location.match);
    const names = [slug(title) ? `${id}-${slug(title)}.md` : null, `${id}.md`].filter((n): n is string => n !== null);
    const name = names.find((n) => match.test(n));
    if (!name) throw new RecordWriteError("record-path-unmatched", `the kind's location.match ${kind.location.match} matches none of ${names.join(", ")}`);
    const path = o.dirRel === "." ? name : `${o.dirRel}/${name}`;
    if (o.source.list(o.dirRel)?.includes(name)) throw new RecordWriteError("record-id-taken", `${path} already exists`);
    let text = renderRecord(data, title ? `\n# ${title}\n` : "");
    let seal: AuthorSeal | undefined;
    if (opts.sign !== undefined) ({ text, seal } = await sealAuthor(o, text, data, id, opts.sign, opts.cwd));
    const warnings = await validateWrite(o, before, path, text);
    if (!opts.dryRun) writeFileSync(abs(o, path), text, { flag: "wx" });
    return {
      $schema: RECORDS_NEW_SCHEMA_ID,
      contract: RECORDS_WRITE_CONTRACT_VERSION,
      kind: o.view,
      path,
      id,
      ...(seal ? { seal } : {}),
      dryRun: !!opts.dryRun,
      warnings,
      ...(opts.dryRun ? { text } : {}),
    };
  } catch (err) {
    return failure<NewErrorCode>(RECORDS_NEW_SCHEMA_ID, err);
  }
}

// ── records amend ────────────────────────────────────────────────────────────

export interface AmendRecordOptions {
  kind: string;
  id: string;
  /** The fields to set, as JSON text. Each replaces the whole top-level field. */
  fields: string;
  dryRun?: boolean;
  cwd: string;
  /** Seal the amended record's author, as `records new` does (#2688). */
  sign?: string | true;
}

/**
 * `records amend`: set top-level fields of one record. A record in a closed
 * state never changes. With approval ranks, a record ranked above 0 (such as
 * a decided decision) changes in place only in its state, to one ranked at
 * least as high, its pins field and its reviews: anything else is a new
 * decision, written as a record that supersedes it (#2524 D4).
 *
 * An amendment moves the record's digest, so an author seal no longer holds
 * (#2688). With `sign` the record is sealed again over the new text; without
 * it, an amendment that moves the digest removes the seal and says so in
 * `sealDropped`, so a record never carries a seal that fails. One that
 * changes only the reviews leaves the digest, and the seal, as they were.
 * `--sign` with nothing to change seals the record as it is.
 */
export async function amendRecord(opts: AmendRecordOptions): Promise<AmendDocument> {
  try {
    const patch = parseFields(opts.fields, "--set");
    const o = await open(opts.kind, opts.cwd);
    const { kind } = o.loaded;
    refuseSealField(o, patch, "--set");
    const before = await readAll(o, o.source);
    const target = findRecord(before, opts.id, kind.name);
    const old = target.data;
    const added = Object.keys(patch).filter((k) => !(k in old));
    const merged = pick({ ...old, ...patch }, [...Object.keys(old), ...schemaOrder(pick(patch, added), o.loaded.schema)]);
    const changed = Object.keys(merged).filter((k) => stableJson(old[k]) !== stableJson(merged[k]));
    if (changed.includes(kind.idField!)) {
      throw new RecordWriteError("amend-id-immutable", `${kind.idField!} never changes: ids are never renumbered. Write a new record that supersedes ${opts.id} instead`);
    }
    const state = target.state;
    const link = kind.supersedes?.key === undefined ? JSON.stringify(opts.id) : `[{"${kind.supersedes.key}": "${opts.id}"}]`;
    const supersede = kind.supersedes ? `chant workspace records new with ${kind.supersedes.field}: ${link}` : `chant workspace records new`;
    if ((changed.length > 0 || opts.sign !== undefined) && state !== null && (kind.closedStates ?? []).includes(state)) {
      throw new RecordWriteError("record-closed", `${opts.id} is ${state}, a closed state, so nothing in it changes. Write a new record that supersedes it: ${supersede}`);
    }
    const rank = (s: unknown): number => (typeof s === "string" ? (kind.approval?.[s] ?? 0) : 0);
    if (changed.length > 0 && kind.approval && rank(state) > 0) {
      const allowed = [kind.stateField, kind.pins?.field, kind.reviews?.field].filter((f): f is string => typeof f === "string");
      const stronger = (kind.states ?? []).filter((s) => rank(s) >= rank(state));
      const bad = changed.filter((k) => !allowed.includes(k));
      if (bad.length > 0) {
        throw new RecordWriteError(
          "amend-supersede-instead",
          `${opts.id} is ${state}, so ${bad.join(", ")} can't change in place: only ${allowed.join(", ")} may. Write the change as a new record that supersedes it (${supersede}); it replaces ${opts.id} once it is ${stronger.filter((s) => rank(s) > 0).join(" or ")}`,
        );
      }
      if (kind.stateField !== undefined && changed.includes(kind.stateField) && rank(merged[kind.stateField]) < rank(state)) {
        throw new RecordWriteError(
          "amend-supersede-instead",
          `${opts.id} is ${state}, and ${JSON.stringify(merged[kind.stateField!])} is approved less strongly: a state only moves to ${stronger.join(", ")}. Write a new record that supersedes it (${supersede})`,
        );
      }
    }
    // Only the changed fields' blocks are rewritten, so the rest of the file keeps its bytes.
    const current = o.source.read(target.path);
    let text = changed.length === 0 ? current : (replaceFields(current, pick(merged, changed), merged) ?? renderRecord(merged, bodyOf(current)));
    // The author seal (#2688): signed again over the new text, or dropped once the text moves.
    let seal: AuthorSeal | undefined;
    let sealDropped: string | undefined;
    const sealable = kind.reviews !== undefined && RECORD_SEAL_FIELD in old;
    if (opts.sign !== undefined) {
      ({ text, seal } = await sealAuthor(o, text, merged, opts.id, opts.sign, opts.cwd));
      merged[RECORD_SEAL_FIELD] = seal;
    } else if (sealable && recordTextDigest(text, digestFields(kind), kind.format) !== recordTextDigest(current, digestFields(kind), kind.format)) {
      const signer = (old[RECORD_SEAL_FIELD] as { signer?: unknown } | null)?.signer;
      delete merged[RECORD_SEAL_FIELD];
      const dropped = removeField(text, RECORD_SEAL_FIELD, merged);
      if (dropped === undefined) throw new RecordWriteError("record-unparseable", `${target.path}: the ${RECORD_SEAL_FIELD} block can't be removed without changing the rest of the file`);
      text = dropped;
      sealDropped = `${opts.id} was sealed${typeof signer === "string" ? ` by ${signer}` : ""}, and the amendment moves its digest, so the seal was removed: seal it again with records amend ${opts.id} --sign`;
    }
    if (stableJson(old[RECORD_SEAL_FIELD]) !== stableJson(merged[RECORD_SEAL_FIELD])) changed.push(RECORD_SEAL_FIELD);
    const warnings = changed.length === 0 ? target.warnings : await validateWrite(o, before, target.path, text);
    if (!opts.dryRun && changed.length > 0) writeFileSync(abs(o, target.path), text);
    return {
      $schema: RECORDS_AMEND_SCHEMA_ID,
      contract: RECORDS_WRITE_CONTRACT_VERSION,
      kind: o.view,
      path: target.path,
      id: opts.id,
      changed,
      ...(seal ? { seal } : {}),
      ...(sealDropped ? { sealDropped } : {}),
      dryRun: !!opts.dryRun,
      warnings,
      ...(opts.dryRun ? { text } : {}),
    };
  } catch (err) {
    return failure<AmendErrorCode>(RECORDS_AMEND_SCHEMA_ID, err);
  }
}

// ── records review ───────────────────────────────────────────────────────────

export interface ReviewRecordOptions {
  kind: string;
  id: string;
  verdict: string;
  /** The reviewer, as the caller names them. chant does not check who it is; a seal does, on read (#2687). */
  by: string;
  note?: string;
  /** The review session the verdict was given in. */
  session?: string;
  dryRun?: boolean;
  cwd: string;
  /** The date written as `on`, YYYY-MM-DD. Defaults to today, in UTC. */
  on?: string;
  /**
   * Seal the verdict (#2687): a key file, resolved against `cwd`, or true for
   * git's `user.signingkey`. Without it the verdict is written unsealed.
   */
  sign?: string | true;
}

/**
 * `records review`: append one verdict to a record's reviews, with the date
 * and the digest of the record text it judged ({@link recordTextDigest}).
 * With `sign`, the verdict carries a seal: an ssh signature over the record
 * id, the digest, the verdict, the reviewer and the date (`trust/seal.ts`).
 */
export async function reviewRecord(opts: ReviewRecordOptions): Promise<ReviewDocument> {
  try {
    if (!(VERDICTS as readonly string[]).includes(opts.verdict)) {
      throw new RecordWriteError("write-usage-invalid", `--verdict takes ${VERDICTS.join(", ")}, not ${JSON.stringify(opts.verdict)}`);
    }
    if (opts.by.trim() === "") throw new RecordWriteError("write-usage-invalid", "--by needs the reviewer's name");
    if (opts.session !== undefined && opts.session === "") throw new RecordWriteError("write-usage-invalid", "--session needs a session id");
    const o = await open(opts.kind, opts.cwd);
    const { kind } = o.loaded;
    if (!kind.reviews) {
      throw new RecordWriteError("review-unsupported", `the ${kind.name} kind declares no reviews field, so its records take no review`);
    }
    const field = kind.reviews.field;
    const before = await readAll(o, o.source);
    const target = findRecord(before, opts.id, kind.name);
    if (target.state !== null && (kind.closedStates ?? []).includes(target.state)) {
      throw new RecordWriteError("record-closed", `${opts.id} is ${target.state}, a closed state, so it takes no more reviews`);
    }
    if (opts.verdict === "dissent" && !(opts.note ?? "").trim()) {
      throw new RecordWriteError("review-note-required", `a dissent needs a reason: pass --note <text> with the concern`);
    }
    const reviews = target.data[field] ?? [];
    if (!Array.isArray(reviews)) throw new RecordWriteError("record-schema-invalid", `${target.path}: ${field} is not a list`);
    const current = o.source.read(target.path);
    const review: Record<string, unknown> = {
      reviewer: opts.by,
      verdict: opts.verdict,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      on: opts.on ?? today(),
      digest: recordTextDigest(current, digestFields(kind), kind.format),
      ...(opts.session !== undefined ? { session: opts.session } : {}),
    };
    if (opts.sign !== undefined) review.seal = await seal(opts.sign, opts.cwd, { record: opts.id, digest: review.digest as string, verdict: opts.verdict, reviewer: opts.by, on: review.on as string });
    // Only the reviews block changes, so the digest the verdict names stays the record's digest (#2672),
    // and a record's author seal, which the digest leaves out too, still holds (#2688).
    const list = [...reviews, review];
    const text = replaceFields(current, { [field]: list }, { ...target.data, [field]: list });
    if (text === undefined) throw new RecordWriteError("record-unparseable", `${target.path}: the ${field} block can't be rewritten in place without changing the rest of the file`);
    const warnings = await validateWrite(o, before, target.path, text);
    if (!opts.dryRun) writeFileSync(abs(o, target.path), text);
    return {
      $schema: RECORDS_REVIEW_SCHEMA_ID,
      contract: RECORDS_WRITE_CONTRACT_VERSION,
      kind: o.view,
      path: target.path,
      id: opts.id,
      review,
      dryRun: !!opts.dryRun,
      warnings,
      ...(opts.dryRun ? { text } : {}),
    };
  } catch (err) {
    return failure<ReviewErrorCode>(RECORDS_REVIEW_SCHEMA_ID, err);
  }
}

/** A seal over one verdict, or a refusal with review-sign-failed. Loaded only when --sign is given. */
async function seal(sign: string | true, cwd: string, v: { record: string; digest: string; verdict: string; reviewer: string; on: string }): Promise<Record<string, unknown>> {
  const { resolveSigningKey, sealVerdict, SealError } = await import("./trust/seal");
  try {
    const key = resolveSigningKey(sign, cwd);
    try {
      return { ...sealVerdict(key.file, v) };
    } finally {
      key.cleanup();
    }
  } catch (err) {
    if (err instanceof SealError) throw new RecordWriteError("review-sign-failed", err.message);
    throw err;
  }
}

// ── The command ──────────────────────────────────────────────────────────────

export const WRITE_USAGE = [
  "chant workspace records new [<kind file or declared kind>] --from <file|-> [--prefix <prefix>] [--sign [<key file>]] [--dry-run]",
  "chant workspace records amend <id> [--kind <kind file>] --set <file|-> [--sign [<key file>]] [--dry-run]",
  "chant workspace records review <id> [--kind <kind file>] --verdict agree|dissent|abstain --by <principal> [--note <text>] [--session <id>] [--sign [<key file>]] [--dry-run]",
].join("\n");

function usage(schema: string, message: string): WriteFailure<"write-usage-invalid"> {
  return { $schema: schema, contract: RECORDS_WRITE_CONTRACT_VERSION, error: { code: "write-usage-invalid", message: `${message}\n${WRITE_USAGE}` } };
}

/**
 * The kind a write goes through when none is named (#2680): the one record
 * kind the declaration nearest above `cwd` names. None declared keeps the
 * message the verb has always given; several are refused, since a write
 * never guesses which kind it means.
 */
function declaredWriteKind(schema: string, cwd: string, missing: string): string | WriteFailure<"write-usage-invalid"> {
  let kinds: ReturnType<typeof declaredKindFiles>;
  try {
    kinds = declaredKindFiles(cwd);
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    return usage(schema, `${missing}; the declaration can't name one: ${err.code}: ${err.describe()}`);
  }
  if (kinds.length === 0) return usage(schema, missing);
  if (kinds.length > 1) {
    return usage(schema, `the declaration names ${kinds.length} record kinds (${kinds.map((k) => k.declared.path).join(", ")}), so name the one to write with --kind`);
  }
  return kinds[0].file;
}

/**
 * The kind file a write names: `arg` itself when it is a file, or else the
 * declared record kind it names (#2683), by the name the declaration gives it
 * or its file's name without `.kind.mjs`, so `records new work` finds
 * `work/work.kind.mjs`. Anything else is returned as given, and loading it
 * fails with kind-unreadable.
 */
export function resolveWriteKind(arg: string, cwd: string): string {
  try {
    if (statSync(resolve(cwd, arg)).isFile()) return arg;
  } catch {
    // Not a file: try the declared kinds.
  }
  let kinds: ReturnType<typeof declaredKindFiles>;
  try {
    kinds = declaredKindFiles(cwd);
  } catch {
    return arg;
  }
  const hit = kinds.filter((k) => (k.declared.name ?? posix.basename(k.declared.path).replace(/(?:\.kind)?\.[cm]?[jt]s$/, "")) === arg);
  return hit.length === 1 ? hit[0].file : arg;
}

/** The text of `--from` or `--set`: a file, or standard input for `-`. */
function readInput(schema: string, flag: string, value: string | undefined, cwd: string): string | WriteFailure<"write-usage-invalid" | "write-input-invalid"> {
  if (value === undefined || value === "") return usage(schema, `${flag} <file|-> is required`);
  try {
    return readFileSync(value === "-" ? 0 : resolve(cwd, value), "utf-8");
  } catch (err) {
    return {
      $schema: schema,
      contract: RECORDS_WRITE_CONTRACT_VERSION,
      error: { code: "write-input-invalid", message: `${flag} ${value} could not be read: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

/** `chant workspace records new|amend|review`. Prints one JSON document; exits 0 when it wrote, or would have with --dry-run. */
export async function runRecordsWrite(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = process.cwd();
  const verb = args.extraPositional;
  const print = (doc: object): number => {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  };
  if (verb === "new") {
    const named = args.extraPositional2 ?? args.kind;
    const kind = named !== undefined ? resolveWriteKind(named, cwd) : declaredWriteKind(RECORDS_NEW_SCHEMA_ID, cwd, "new needs the kind file");
    if (typeof kind !== "string") return print(kind);
    const input = readInput(RECORDS_NEW_SCHEMA_ID, "--from", args.migrateFrom, cwd);
    if (typeof input !== "string") return print(input);
    return print(await newRecord({ kind, fields: input, prefix: args.prefix, sign: args.sign, dryRun: args.dryRun, cwd }));
  }
  const schema = verb === "amend" ? RECORDS_AMEND_SCHEMA_ID : RECORDS_REVIEW_SCHEMA_ID;
  const id = args.extraPositional2;
  if (!id) return print(usage(schema, `${verb} needs the record's id`));
  const kind = args.kind !== undefined ? resolveWriteKind(args.kind, cwd) : declaredWriteKind(schema, cwd, "--kind <kind file> is required");
  if (typeof kind !== "string") return print(kind);
  if (verb === "amend") {
    const input = readInput(schema, "--set", args.set, cwd);
    if (typeof input !== "string") return print(input);
    return print(await amendRecord({ kind, id, fields: input, sign: args.sign, dryRun: args.dryRun, cwd }));
  }
  if (args.verdict === undefined) return print(usage(schema, "--verdict agree|dissent|abstain is required"));
  if (args.by === undefined) return print(usage(schema, "--by <principal> is required"));
  return print(
    await reviewRecord({ kind, id, verdict: args.verdict, by: args.by, note: args.note, session: args.session, sign: args.sign, dryRun: args.dryRun, cwd }),
  );
}
