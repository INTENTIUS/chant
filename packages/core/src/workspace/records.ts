/**
 * Records read through a record kind (#2524 D4), first-test slice (#2546).
 *
 * A record kind is data. It says where its records live, which JSON Schema
 * they follow and which of their states are closed. This module reads every
 * record a kind locates, parses its structured core (the front matter, as the
 * JSON subset of YAML, or the whole file as one I-JSON object, ws-053),
 * validates it against the kind's schema and derives supersession from the
 * records' own `supersedes` links. It never writes a record; `records-write.ts`
 * does, through the rules here (#2670).
 *
 * A record that fails any of that is still returned, with reason codes, and the
 * read succeeds. Only a failure to read the kind, its schema or the revision is
 * an error. Seals, attestation and the workspace declaration come later (#2546,
 * #2534); nothing here needs a `chant.workspace.json`.
 *
 * Everything under `workspace/` loads only when a `chant workspace` command
 * runs. The level-0 goldens (#2526) fail if a level-0 command loads it.
 */

import { createHash } from "node:crypto";
import { sha256Hex } from "../content-digest";
import { readFileSync, statSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { importLexiconModule, registerLexiconDeclarations } from "../lexicon-module";
import type { ReasonCode } from "./reason-codes";
import { checkPins, pinEntries, type AssetPin } from "./record-assets";
import { joinSessions, type SessionCitation } from "./record-sessions";
import type { RecordSource } from "./record-source";
import type { WorkspaceTree } from "./tree";

// ── Reason codes ─────────────────────────────────────────────────────────────

/**
 * Why one record is not valid. The list is closed: a reader may switch on it,
 * and a new code is a contract change (#2536).
 */
export const RECORD_REASON_CODES = [
  /** No front matter, a YAML error or a value outside the JSON subset of YAML, or for a JSON kind a file that is not one object or repeats a member name. */
  "record-unparseable",
  /** The record's front matter, or its JSON object, does not match the kind's schema. */
  "record-schema-invalid",
  /** Another record earlier in path order has the same id. */
  "record-id-duplicate",
  /** A `supersedes` link names an id no record has. */
  "record-supersedes-unknown",
  /** A second closed record supersedes a record another one already superseded. */
  "record-supersedes-conflict",
  /** A closed session's seal is not the digest of its text: it changed after it closed (#2673). */
  "session-seal-mismatch",
  /** A session's verdict names a record the kind's subject records do not have (#2673). */
  "session-verdict-unknown-record",
] as const satisfies readonly ReasonCode[];
export type RecordReasonCode = (typeof RECORD_REASON_CODES)[number];

/**
 * Why a record carries a warning. Closed, like the reason codes. A warning
 * never makes a record invalid, and `--current` still lists the record.
 */
export const RECORD_WARNING_CODES = [
  /** A pinned file's bytes no longer hash to the pinned sha256 (#2549). */
  "asset-drift",
  /** A pinned file does not exist in the tree read (#2549). */
  "asset-missing",
  /**
   * A pinned file is unchanged since a record this one supersedes pinned it at
   * the same hash: the decision changed and the artifact did not follow (#2549).
   */
  "asset-stale",
  /** A supersedes link from a record whose state is weaker than the one it names, so it has no effect yet (#2524 D4). */
  "record-supersedes-pending",
  /**
   * The kind's pins field is an empty list: the record cites no evidence and
   * pins no file. Information for a reviewer, such as a decision made in a
   * product's own design flow with nothing to cite (#2654).
   */
  "record-no-evidence",
  /**
   * A verdict in the kind's reviews list names no `digest`, so it is not bound
   * to the text it judged. It still counts toward the quorum, and an
   * amendment does not stop it counting (#2672).
   */
  "review-undigested",
] as const satisfies readonly ReasonCode[];
export type RecordWarningCode = (typeof RECORD_WARNING_CODES)[number];

/**
 * Why a verdict does not count toward a record's quorum (#2671). Closed, like
 * the reason codes. A verdict with none of these counts.
 */
export const REVIEW_REASON_CODES = [
  /** The reviewer is the record's decider. */
  "review-decider",
  /** The reviewer holds the agent role in the trust policy at base. */
  "review-agent",
  /** A later verdict by the same principal, after normalising, replaces this one. */
  "review-duplicate",
  /** The verdict's digest is not the digest of the record's text now: the record changed after the verdict (#2672). */
  "review-older-digest",
  /** An attestation policy is active at base, and the verdict carries no seal. */
  "review-unattested",
] as const satisfies readonly ReasonCode[];
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

export interface RecordWarning {
  code: RecordWarningCode;
  message: string;
}

/**
 * Why the read as a whole failed. Also closed. The command exits 1 with one of
 * these and returns no records.
 */
export const READ_ERROR_CODES = [
  /** The kind file is missing or could not be imported. */
  "kind-unreadable",
  /** The kind file exports no `recordKind`, or its shape is wrong. */
  "kind-invalid",
  /** The schema file the kind names is missing or is not JSON. */
  "schema-unreadable",
  /** The schema's `$id` differs from the id the kind names. */
  "schema-id-mismatch",
  /** The schema itself does not compile. */
  "schema-invalid",
  /** The records directory does not exist, in the tree or at the revision. */
  "location-missing",
  /** `--at` was given outside a git repository. */
  "not-a-git-repository",
  /** `--at` names no commit. */
  "revision-unknown",
] as const satisfies readonly ReasonCode[];
export type ReadErrorCode = (typeof READ_ERROR_CODES)[number];

export class RecordReadError extends Error {
  constructor(
    readonly code: ReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RecordReadError";
  }
}

// ── The kind ─────────────────────────────────────────────────────────────────

const idPattern = /^[a-z][a-z0-9-]*$/;

/** The formats a kind file may name. Closed. */
export const RECORD_FORMATS = ["markdown-front-matter", "json"] as const;
export type RecordFormat = (typeof RECORD_FORMATS)[number];

/** The data a kind file exports as `recordKind`. */
export const recordKindSchema = z
  .object({
    /** The kind's name, such as `decision`. */
    name: z.string().regex(idPattern),
    /** Where the records are, relative to the kind file's directory. */
    location: z
      .object({
        dir: z.string().min(1),
        /** A regular expression the file name must match. Only that directory is read; subdirectories are not. */
        match: z.string().min(1),
      })
      .strict(),
    /**
     * How a file holds its record's structured core: `markdown-front-matter`,
     * the YAML front matter of a Markdown file, or `json`, the whole file as
     * one JSON object (ws-053).
     */
    format: z.enum(RECORD_FORMATS),
    schema: z
      .object({
        /** The schema's `$id`. A schema file with a different `$id` is refused. */
        id: z.string().min(1),
        /** The schema file, relative to the kind file's directory. */
        path: z.string().min(1),
        /**
         * Schema files the schema `$ref`s, each by its `$id` and path relative
         * to the kind file's directory (ws-053). Each is checked for its `$id`
         * and added to the validator before the schema compiles. Optional.
         */
        refs: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) }).strict()).optional(),
      })
      .strict(),
    /** The field holding the record's id. A kind has this or `idFrom`, never both. */
    idField: z.string().min(1).optional(),
    /**
     * `sha256`: the record's id is the lowercase hex SHA-256 of the file's
     * bytes, and the file name's stem (up to its first `.`) is the hash the
     * name claims (ws-053). In place of `idField`.
     */
    idFrom: z.literal("sha256").optional(),
    /**
     * The field holding the record's state. `stateField`, `states` and
     * `closedStates` are given together or not at all; a kind without them
     * has no lifecycle, and its records have state null (ws-053).
     */
    stateField: z.string().min(1).optional(),
    states: z.array(z.string().min(1)).min(1).optional(),
    /** States whose records are final. A `supersedes` link takes effect only from a record in one of them. */
    closedStates: z.array(z.string().min(1)).optional(),
    /**
     * The field of links to superseded records. With `key`, a list of objects
     * whose `key` holds the target id; without it, one id or a list of ids
     * (ws-053). Optional, and only on a kind with states.
     */
    supersedes: z.object({ field: z.string().min(1), key: z.string().min(1).optional() }).strict().optional(),
    /**
     * How strongly each state is approved (#2524 D4). With it, a supersedes
     * link takes effect when the new record's rank is above 0 and at least the
     * old record's, "under an equal or stricter approval rule". A state it
     * leaves out ranks 0. Without it, a link takes effect only from a record
     * in a closed state.
     */
    approval: z.record(z.string(), z.number().int().min(0)).optional(),
    /**
     * The front-matter list whose entries may pin a workspace file, as
     * `{path, sha256}` (#2549). Optional: a kind without it pins nothing.
     */
    pins: z.object({ field: z.string().min(1) }).strict().optional(),
    /**
     * The front-matter list of what a record governs. Its `member:<name>` and
     * `path:<path>` entries are the record's links in `chant workspace graph`
     * (#2549). Optional.
     */
    constrains: z.object({ field: z.string().min(1) }).strict().optional(),
    /**
     * The front-matter list of review verdicts and the field naming the
     * decider (#2671, #2672). With it, each record gets a digest of its text
     * without that list, and `records --json` computes its quorum. Each
     * entry holds `reviewer`, `verdict` (agree, dissent or abstain) and
     * optionally `digest`, `note`, `proposes`, `addressed_by` and
     * `withdrawn_on`. Optional.
     */
    reviews: z.object({ field: z.string().min(1), decider: z.string().min(1) }).strict().optional(),
    /**
     * A review-session kind (#2673, #2650 C10): the front-matter list of the
     * verdicts a session produced, the field that seals a closed session, and
     * the records its verdicts name, as the kind file that locates them
     * (relative to this kind file's directory). The entries of that kind's
     * reviews list (its `reviews.field`, or `reviews`) name a session in
     * `session`. Optional.
     */
    session: z
      .object({
        verdicts: z.string().min(1),
        seal: z.string().min(1),
        subjects: z.object({ kind: z.string().min(1) }).strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((k) => (k.idField === undefined) !== (k.idFrom === undefined), {
    message: "a kind names its id with exactly one of idField and idFrom",
    path: ["idField"],
  })
  .refine((k) => new Set([k.stateField === undefined, k.states === undefined, k.closedStates === undefined]).size === 1, {
    message: "stateField, states and closedStates are given together or not at all",
    path: ["states"],
  })
  .refine((k) => k.states !== undefined || k.supersedes === undefined, {
    message: "a kind without states cannot have supersedes: a link takes effect only from a closed or ranked state",
    path: ["supersedes"],
  })
  .refine((k) => k.states !== undefined || k.session === undefined, {
    message: "a session kind must have states: a session is sealed when it reaches a closed state",
    path: ["session"],
  })
  .refine((k) => k.states !== undefined || k.approval === undefined, {
    message: "a kind without states cannot have approval ranks",
    path: ["approval"],
  })
  .refine((k) => (k.closedStates ?? []).every((s) => (k.states ?? []).includes(s)), {
    message: "every closed state must be listed in states",
    path: ["closedStates"],
  })
  .refine((k) => Object.keys(k.approval ?? {}).every((s) => (k.states ?? []).includes(s)), {
    message: "every state approval ranks must be listed in states",
    path: ["approval"],
  });

export type RecordKind = z.infer<typeof recordKindSchema>;

/** A kind as loaded: its data, where it came from, and its schema. */
export interface LoadedRecordKind {
  kind: RecordKind;
  /** Absolute path of the kind file. */
  file: string;
  /** Absolute path of the records directory in the working tree. */
  dir: string;
  schema: Record<string, unknown>;
  /** The schema files `schema.refs` names, in order (ws-053). Empty without it. */
  refs: Record<string, unknown>[];
}

/**
 * Import the kind file at `path` through the path loader lexicons use (#2520).
 * The kind is registered under a name no lexicon package can have (npm names
 * hold no `:`), imported and unregistered again, so no lexicon lookup sees it.
 */
export async function importKindModule(path: string): Promise<Record<string, unknown>> {
  const name = `record-kind:${path}`;
  registerLexiconDeclarations([{ name, module: path }], dirname(path));
  try {
    const mod = await importLexiconModule(name);
    if (!mod) throw new Error(`${path} was not registered`);
    return mod;
  } finally {
    registerLexiconDeclarations([name], dirname(path));
  }
}

/** Load a kind file and the schema it names. `path` is resolved against `cwd`. */
export async function loadRecordKind(path: string, cwd: string = process.cwd()): Promise<LoadedRecordKind> {
  const file = resolve(cwd, path);
  let mod: Record<string, unknown>;
  try {
    statSync(file);
    mod = await importKindModule(file);
  } catch (err) {
    throw new RecordReadError("kind-unreadable", `kind file ${path} could not be loaded: ${message(err)}`);
  }
  const parsed = recordKindSchema.safeParse(mod.recordKind);
  if (!parsed.success) {
    const detail =
      mod.recordKind === undefined
        ? "it has no recordKind export"
        : parsed.error.issues.map((i) => `${i.path.join(".") || "recordKind"}: ${i.message}`).join("; ");
    throw new RecordReadError("kind-invalid", `kind file ${path} is not a record kind: ${detail}`);
  }
  const kind = parsed.data;
  const base = dirname(file);
  const schema = readSchemaFile(kind, base, path, kind.schema);
  const refs = (kind.schema.refs ?? []).map((ref) => readSchemaFile(kind, base, path, ref));
  return { kind, file, dir: resolve(base, kind.location.dir), schema, refs };
}

/** A schema file a kind names, refused when it can't be read or its `$id` is not the one the kind names. */
function readSchemaFile(kind: RecordKind, base: string, kindPath: string, named: { id: string; path: string }): Record<string, unknown> {
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(readFileSync(resolve(base, named.path), "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new RecordReadError("schema-unreadable", `schema ${named.path} named by ${kindPath} could not be read: ${message(err)}`);
  }
  if (schema === null || typeof schema !== "object" || schema.$id !== named.id) {
    throw new RecordReadError(
      "schema-id-mismatch",
      `kind ${kind.name} names schema ${named.id}, but ${named.path} has $id ${JSON.stringify(schema?.$id)}`,
    );
  }
  return schema;
}

// ── Front matter ─────────────────────────────────────────────────────────────

export type FrontMatter = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/**
 * The front matter of a Markdown file, limited to what YAML and JSON share
 * (#2524 D4). Line endings are normalised first. Aliases, and any value JSON
 * cannot hold, are refused, so the same text always reads as the same JSON.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const normalised = text.replace(/\r\n?/g, "\n");
  const m = normalised.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) return { ok: false, message: "no front matter: the file must start with a --- line and close it with another" };
  let value: unknown;
  try {
    value = yaml.load(m[1], { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    return { ok: false, message: `front matter is not valid YAML: ${message(err).split("\n")[0]}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "front matter must be a mapping" };
  }
  const problem = nonJson(value, "", new Set());
  if (problem) return { ok: false, message: problem };
  return { ok: true, value: value as Record<string, unknown> };
}

// ── JSON records ─────────────────────────────────────────────────────────────

/**
 * A JSON record: the whole file is one object, read as I-JSON (RFC 7493)
 * requires on the two points JSON.parse lets through (ws-053). A top-level
 * value other than an object is refused, and so is a member name that repeats
 * within one object, at any depth, which JSON.parse accepts by keeping the
 * last value. Names compare after their escapes are decoded, so `"a"` and
 * `"\u0061"` are the same name. A number too large for a double is refused as
 * front matter's is.
 */
export function parseJsonRecord(text: string): FrontMatter {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `not valid JSON: ${message(err).split("\n")[0]}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "a JSON record must be one object at the top level" };
  }
  const scan = scanJson(text);
  if (scan.duplicate) return { ok: false, message: `${scan.duplicate.at || "/"}: member name ${JSON.stringify(scan.duplicate.name)} repeats, which I-JSON refuses` };
  const problem = nonJson(value, "", new Set());
  if (problem) return { ok: false, message: problem };
  return { ok: true, value: value as Record<string, unknown> };
}

/** A record's structured core, parsed as the kind's format says. */
export function parseRecord(format: RecordFormat, text: string): FrontMatter {
  return format === "json" ? parseJsonRecord(text) : parseFrontMatter(text);
}

/** Where one top-level member of a JSON object sits in its text. */
interface JsonMember {
  name: string;
  /** Index of the opening quote of the member's name. */
  start: number;
  /** Index just past the last character of the member's value. */
  end: number;
}

/**
 * One pass over text JSON.parse accepted: the top-level object's members, with
 * where each starts and ends, and the first member name that repeats within
 * one object at any depth.
 */
function scanJson(text: string): { members: JsonMember[]; duplicate?: { name: string; at: string } } {
  const members: JsonMember[] = [];
  // One frame per open object or array: an object's names so far, or null for an array.
  const stack: { names: Set<string> | null; path: string; key?: string; index: number }[] = [];
  let pendingTop: { name: string; start: number } | undefined;
  let valueStart = -1;
  const closeValue = (end: number): void => {
    // A value just ended at `end`; if it is a top-level member's value, record the member.
    if (stack.length === 1 && pendingTop) {
      members.push({ ...pendingTop, end });
      pendingTop = undefined;
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i, j + 1);
      let k = j + 1;
      while (k < text.length && /[ \t\n\r]/.test(text[k])) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ":" && top?.names) {
        const name = JSON.parse(raw) as string;
        if (top.names.has(name)) return { members, duplicate: { name, at: top.path } };
        top.names.add(name);
        top.key = name;
        if (stack.length === 1) pendingTop = { name, start: i };
        i = k + 1;
        continue;
      }
      closeValue(j + 1);
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") {
      const parent = stack[stack.length - 1];
      const at = parent ? `${parent.path}/${parent.names ? parent.key : parent.index}` : "";
      stack.push({ names: c === "{" ? new Set() : null, path: at, index: 0 });
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      stack.pop();
      closeValue(i + 1);
      i++;
      continue;
    }
    if (c === ",") {
      const top = stack[stack.length - 1];
      if (top && !top.names) top.index++;
      i++;
      continue;
    }
    if (/[ \t\n\r:]/.test(c)) {
      i++;
      continue;
    }
    // A number, true, false or null.
    valueStart = i;
    while (i < text.length && !/[ \t\n\r,\]}]/.test(text[i])) i++;
    if (valueStart < i) closeValue(i);
  }
  return { members };
}

/** The first thing in `v` that JSON cannot say, or that only an alias can produce. */
function nonJson(v: unknown, at: string, seen: Set<object>): string | undefined {
  if (v === null || typeof v === "string" || typeof v === "boolean") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? undefined : `${at || "/"}: ${v} is not a JSON number`;
  if (typeof v !== "object") return `${at || "/"}: a ${typeof v} is not a JSON value`;
  if (seen.has(v)) return `${at || "/"}: YAML aliases are not allowed`;
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = nonJson(v[i], `${at}/${i}`, seen);
      if (p) return p;
    }
    return undefined;
  }
  if (Object.getPrototypeOf(v) !== Object.prototype) return `${at || "/"}: not a plain mapping`;
  for (const [k, x] of Object.entries(v)) {
    const p = nonJson(x, `${at}/${k}`, seen);
    if (p) return p;
  }
  return undefined;
}

// ── Record digest ────────────────────────────────────────────────────────────

/**
 * The digest a review verdict names: the lowercase hex SHA-256 of the record
 * file's text with its reviews block taken out of the front matter (#2672), or
 * for a JSON record its reviews member taken out of the object (ws-053).
 * Adding, changing or removing a verdict leaves it as it was; any other edit
 * to the file changes it, so a verdict given before an amendment stops
 * counting.
 *
 * The rule, which a hand-editor can follow with a text editor and
 * `sha256sum`:
 *
 * 1. Line endings become LF (CRLF and a lone CR each become one LF).
 * 2. When the text starts with a `---` line and a later line is exactly
 *    `---`, the lines between them are the front matter. In it, the line
 *    that starts, at column 0, with the key `field` (bare, or in single or
 *    double quotes), optional spaces or tabs and a `:`, is removed, and so
 *    is every line after it, up to the closing `---`, that is empty or
 *    starts with a space, a tab, `#` or `-`. Removal stops at the first
 *    other line. Everything else, the `---` lines and the body included, is
 *    kept byte for byte.
 * 3. The digest is the SHA-256 of the result's UTF-8 bytes.
 *
 * Text with no front matter, or no such key, is hashed after step 1 alone.
 * A writer that adds a verdict must change only the reviews block: a
 * reformatted front matter is a new digest, and every earlier verdict stops
 * counting.
 */
export function recordTextDigest(text: string, field: string | null = "reviews", format: RecordFormat = "markdown-front-matter"): string {
  const lf = text.replace(/\r\n?/g, "\n");
  const kept = field === null ? lf : format === "json" ? withoutMember(lf, field) : withoutBlock(lf, field);
  return createHash("sha256").update(kept, "utf8").digest("hex");
}

/**
 * `text` with the top-level member `field` removed from a JSON record, by the
 * rule a hand-editor follows for a JSON record (ws-053):
 *
 * 1. Line endings become LF, as for Markdown.
 * 2. When the text is a JSON record (one object, no repeated member name) and
 *    its top-level object has a member named `field`, that member is deleted:
 *    the whitespace right before its name, the name, the colon, the value,
 *    and one comma with the whitespace right before that comma. The comma is
 *    the one after the value when another member follows, or else the one
 *    before the member, when a member precedes it. Nothing else changes: other
 *    members, their order, the indentation and the final newline stay byte
 *    for byte.
 * 3. The digest is the SHA-256 of the result's UTF-8 bytes.
 *
 * So in a pretty-printed file, deleting the `"reviews": [...]` lines and the
 * comma that separated the member from its neighbour gives the text to hash.
 * Text that is not a JSON record, or has no such member, is hashed after step 1
 * alone. A writer that adds a verdict changes only that member's value.
 */
function withoutMember(text: string, field: string): string {
  const parsed = parseJsonRecord(text);
  if (!parsed.ok) return text;
  const { members } = scanJson(text);
  const at = members.findIndex((m) => m.name === field);
  if (at < 0) return text;
  const m = members[at];
  let start = m.start;
  while (start > 0 && /[ \t\n]/.test(text[start - 1])) start--;
  let end = m.end;
  if (at + 1 < members.length) {
    // The comma after the value, and the whitespace before it.
    let k = end;
    while (/[ \t\n]/.test(text[k])) k++;
    end = k + 1;
  } else if (at > 0) {
    // The comma before the member, and the whitespace between it and the previous value.
    let k = start - 1;
    while (k > 0 && text[k] !== ",") k--;
    while (k > 0 && /[ \t\n]/.test(text[k - 1])) k--;
    start = k;
  }
  return text.slice(0, start) + text.slice(end);
}

/** `text` with the top-level `field` block removed from its front matter, by the rule {@link recordTextDigest} states. */
function withoutBlock(text: string, field: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") return text;
  const close = lines.indexOf("---", 1);
  if (close < 0) return text;
  const key = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const starts = new RegExp(`^(?:${key}|"${key}"|'${key}')[ \\t]*:(?:[ \\t]|$)`);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i < close && starts.test(lines[i])) {
      while (i + 1 < close && /^(?:$|[ \t#-])/.test(lines[i + 1])) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

// ── Quorum ───────────────────────────────────────────────────────────────────

/** The quorum a workspace sets when its declaration names none: two verdicts besides the decider's (#2555). */
export const DEFAULT_QUORUM = 2;

/** A principal as the quorum compares it: NFKC, trimmed and lower-cased, so `alice` and `Alice ` are one reviewer (#2671). */
export function normalisePrincipal(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}

/** One verdict as the quorum reads it. */
export interface QuorumVerdict {
  /** The entry's position in the record's reviews list, from 0. */
  index: number;
  /** The reviewer, normalised. */
  principal: string;
  /** The reviewer as written. */
  reviewer: string;
  verdict: "agree" | "dissent" | "abstain";
  /** The digest the verdict names, or null when it names none. */
  digest: string | null;
  /** Why it does not count. Absent on a counted verdict. */
  reason?: { code: ReviewReasonCode; message: string };
}

/** A dissent that is neither addressed nor withdrawn. */
export interface OpenConcern {
  index: number;
  principal: string;
  reviewer: string;
  note: string | null;
  /** The proposed decision the dissent opened, when it names one. */
  proposes?: string;
}

export interface Quorum {
  /** How many counted agree verdicts, besides the decider's, the record needs. */
  need: number;
  /** Whether `need` comes from the workspace declaration or is the default. */
  needFrom: "declaration" | "default";
  /** Counted verdicts that agree. */
  agreed: number;
  /** Verdicts that count: one per principal, the latest, after the exclusions. */
  counted: QuorumVerdict[];
  /** Verdicts that don't, each with its reason. */
  notCounted: QuorumVerdict[];
  openConcerns: OpenConcern[];
  /** `agreed` reaches `need`. */
  met: boolean;
  /** `met`, with at least one open concern. A met quorum with an open concern is never consensus (RFC 7282). */
  metWithObjections: boolean;
}

export interface QuorumOptions {
  need: number;
  needFrom: "declaration" | "default";
  /** Normalised principals that hold the agent role. */
  agents: ReadonlySet<string>;
  /** Whether an attestation policy is active, so a verdict needs a seal to count. */
  attestation: boolean;
}

const VERDICTS = new Set(["agree", "dissent", "abstain"]);

/**
 * The quorum of one record, read from its reviews list, or null when the
 * kind has no reviews list or the front matter could not be read (#2671).
 * Malformed entries are skipped; the schema reports them.
 *
 * A verdict is not counted when its reviewer is the decider, holds the agent
 * role, names a digest other than the record's own now, or carries no seal
 * under an active attestation policy, in that order. Of the rest, the latest
 * verdict per principal counts and each earlier one is a duplicate. No
 * verdict carries a seal yet (#2546), so under an active policy none counts.
 */
export function computeQuorum(kind: RecordKind, entry: Pick<RecordEntry, "data" | "digest">, options: QuorumOptions): Quorum | null {
  if (!kind.reviews || entry.data === null) return null;
  const list = entry.data[kind.reviews.field];
  const decidedBy = entry.data[kind.reviews.decider];
  const decider = typeof decidedBy === "string" ? normalisePrincipal(decidedBy) : null;
  const verdicts: QuorumVerdict[] = [];
  const openConcerns: OpenConcern[] = [];
  (Array.isArray(list) ? list : []).forEach((raw, index) => {
    if (raw === null || typeof raw !== "object") return;
    const r = raw as Record<string, unknown>;
    if (typeof r.reviewer !== "string" || typeof r.verdict !== "string" || !VERDICTS.has(r.verdict)) return;
    const v: QuorumVerdict = {
      index,
      principal: normalisePrincipal(r.reviewer),
      reviewer: r.reviewer,
      verdict: r.verdict as QuorumVerdict["verdict"],
      digest: typeof r.digest === "string" ? r.digest : null,
    };
    if (v.principal === decider) {
      v.reason = { code: "review-decider", message: `${v.reviewer} decided this record, and the quorum counts verdicts besides the decider's` };
    } else if (options.agents.has(v.principal)) {
      v.reason = { code: "review-agent", message: `${v.reviewer} holds the agent role in the trust policy at base, and an agent's verdict does not count` };
    } else if (v.digest !== null && v.digest !== entry.digest) {
      v.reason = { code: "review-older-digest", message: `${v.reviewer} judged the text at digest ${v.digest.slice(0, 12)}, and the record's text is now at ${entry.digest.slice(0, 12)}` };
    } else if (options.attestation) {
      v.reason = { code: "review-unattested", message: `an attestation policy is active at base, and the verdict by ${v.reviewer} carries no seal` };
    }
    verdicts.push(v);
    if (v.verdict === "dissent" && r.addressed_by == null && r.withdrawn_on == null) {
      openConcerns.push({
        index,
        principal: v.principal,
        reviewer: v.reviewer,
        note: typeof r.note === "string" ? r.note : null,
        ...(typeof r.proposes === "string" ? { proposes: r.proposes } : {}),
      });
    }
  });
  // The latest verdict per principal stands; earlier ones are duplicates.
  const latest = new Map<string, QuorumVerdict>();
  for (const v of verdicts) if (!v.reason) latest.set(v.principal, v);
  for (const v of verdicts) {
    if (v.reason || latest.get(v.principal) === v) continue;
    const later = latest.get(v.principal)!;
    v.reason = { code: "review-duplicate", message: `the later verdict by ${JSON.stringify(later.reviewer)} (entry ${later.index}) replaces this one, and a principal counts once` };
  }
  const counted = verdicts.filter((v) => !v.reason);
  const agreed = counted.filter((v) => v.verdict === "agree").length;
  const met = agreed >= options.need;
  return {
    need: options.need,
    needFrom: options.needFrom,
    agreed,
    counted,
    notCounted: verdicts.filter((v) => v.reason),
    openConcerns,
    met,
    metWithObjections: met && openConcerns.length > 0,
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface RecordReason {
  code: RecordReasonCode;
  message: string;
}

export interface RecordEntry {
  /** The record's id, or null when it could not be read. */
  id: string | null;
  /** Path from the repository root (or the working directory outside git), with `/` separators. */
  path: string;
  /** The record's state as written, or null when it could not be read. */
  state: string | null;
  valid: boolean;
  reasons: RecordReason[];
  /** The id of the closed record whose `supersedes` link replaces this one, or null. */
  supersededBy: string | null;
  /** The record's structured core as JSON (the front matter, or the whole JSON file), or null when it could not be parsed. */
  data: Record<string, unknown> | null;
  /**
   * Each workspace file the record pins, checked against the tree read
   * (#2549). Empty when nothing was checked. A content-addressed record whose
   * name claims a hash other than its bytes' lists itself, drifted (ws-053).
   */
  assets: AssetPin[];
  /** Findings that leave the record valid, such as a pinned file that changed (#2549). */
  warnings: RecordWarning[];
  /** {@link recordTextDigest} of the file's text, without the kind's reviews list when it has one (#2672). */
  digest: string;
  /** For a session kind only: the subject records' review entries that name this session (#2673). */
  citedBy?: SessionCitation[];
}

export interface ReadRecordsOptions {
  /** Where record paths are reported from, and what `source` reads relative to. */
  root: string;
  source: RecordSource;
  /** Leave out records a closed record supersedes. */
  current?: boolean;
  /**
   * The workspace root the kind's pins resolve in: the working tree, or the
   * revision read (#2549). Without it no pin is checked.
   */
  assets?: WorkspaceTree;
  /**
   * When files last changed and records were recorded, in the history of the
   * revision read, for `asset-stale` (#2549). Without it only the hashes are
   * compared.
   */
  history?: RecordHistory;
  /**
   * For a session kind: the records its `session.subjects.kind` locates, read
   * from the same tree (#2673). Without them no verdict is checked and no
   * session is cited.
   */
  subjects?: { records: RecordEntry[]; reviews: string };
  /**
   * The workspace root, from `root` with / separators ("." for `root`
   * itself): where a content-addressed record's own path is reported from
   * when it lists itself in `assets` (ws-053). Defaults to ".".
   */
  workspaceRoot?: string;
}

/** Commit times, in seconds since the epoch, read from git. */
export interface RecordHistory {
  /** The last commit that changed `path` (from the workspace root), or null when unknown. */
  fileChanged(path: string): number | null;
  /** The commit that added the record at `path` (from the repository root), or null when it is not committed. */
  recorded(path: string): number | null;
}

export interface ReadRecordsResult {
  records: RecordEntry[];
  summary: { total: number; valid: number; invalid: number; superseded: number };
}

type Validator = (data: unknown) => { ok: true } | { ok: false; errors: string[] };

/** One ajv error, compiled with `verbose` so the failing schema and data come with it. */
interface SchemaError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message?: string;
  params?: { failingKeyword?: string };
  parentSchema?: Record<string, unknown>;
  data?: unknown;
}

/**
 * ajv's errors as `<path> <message>` lines. A failed `if` whose `then` or
 * `else` branch has a `description` is reported by that description alone, in
 * place of the branch's own errors, with each `{field}` filled from the value
 * the branch checked. The decision schema words its dissent rule this way, so
 * the message names the reviewer (#2652). The schema stays plain JSON Schema,
 * with no keyword a strict validator would refuse.
 */
function renderSchemaErrors(errors: readonly SchemaError[]): string[] {
  const replaced: string[] = [];
  const described = new Map<SchemaError, string>();
  for (const e of errors) {
    const branch = e.keyword === "if" ? e.params?.failingKeyword : undefined;
    const text = branch ? (e.parentSchema?.[branch] as { description?: unknown } | undefined)?.description : undefined;
    if (!branch || typeof text !== "string") continue;
    const at = e.data !== null && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
    described.set(e, text.replace(/\{([A-Za-z0-9_]+)\}/g, (all, key: string) => (typeof at[key] === "string" ? (at[key] as string) : all)));
    replaced.push(`${e.schemaPath.replace(/\/if$/, "")}/${branch}/`);
  }
  return errors
    .filter((e) => described.has(e) || !replaced.some((prefix) => e.schemaPath.startsWith(prefix)))
    .map((e) => `${e.instancePath || "/"} ${described.get(e) ?? e.message ?? "is invalid"}`);
}

async function compileSchema(schema: Record<string, unknown>, refs: readonly Record<string, unknown>[] = []): Promise<Validator> {
  const mod = (await import("ajv")) as unknown as { default: unknown };
  // ajv is CommonJS; its class is the default export, or that export's own default.
  const Ajv = ((mod.default as { default?: unknown }).default ?? mod.default) as new (opts: object) => {
    addSchema(s: object): unknown;
    compile(s: object): ((d: unknown) => boolean) & { errors?: SchemaError[] | null };
  };
  let validate: ReturnType<InstanceType<typeof Ajv>["compile"]>;
  try {
    const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
    // The files the schema $refs, registered by their $id first (ws-053).
    for (const ref of refs) ajv.addSchema(ref);
    validate = ajv.compile(schema);
  } catch (err) {
    throw new RecordReadError("schema-invalid", `the kind's schema does not compile: ${message(err)}`);
  }
  return (data) => (validate(data) ? { ok: true } : { ok: false, errors: renderSchemaErrors(validate.errors ?? []) });
}

/**
 * The ids a record's supersedes field names (ws-053). With the kind's `key`,
 * the field is a list of objects and each one's `key` holds an id; without
 * it, the field holds one id or a list of ids. Anything else names none.
 */
export function supersedesTargets(kind: Pick<RecordKind, "supersedes">, data: Record<string, unknown> | null): string[] {
  if (!kind.supersedes || data === null) return [];
  const { field, key } = kind.supersedes;
  const value = data[field];
  if (key === undefined && typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const ids = key === undefined ? value : value.map((l) => (l !== null && typeof l === "object" ? (l as Record<string, unknown>)[key] : undefined));
  return ids.filter((x): x is string => typeof x === "string");
}

/** The stem of a file name: the name up to its first `.`, the hash a content-addressed record's name claims (ws-053). */
function nameStem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.indexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Read every record `loaded` locates, through `options.source`. */
export async function readRecords(loaded: LoadedRecordKind, options: ReadRecordsOptions): Promise<ReadRecordsResult> {
  const { kind } = loaded;
  const dirRel = toPosix(relative(options.root, loaded.dir)) || ".";
  const names = options.source.list(dirRel);
  if (names === undefined) {
    throw new RecordReadError("location-missing", `records directory ${dirRel} does not exist${options.source.label}`);
  }
  const match = new RegExp(kind.location.match);
  const validate = await compileSchema(loaded.schema, loaded.refs);
  const workspaceRoot = options.workspaceRoot ?? ".";

  const entries: RecordEntry[] = [];
  const texts = new Map<string, string>();
  for (const name of names.filter((n) => match.test(n)).sort()) {
    const path = dirRel === "." ? name : `${dirRel}/${name}`;
    const text = options.source.read(path);
    const entry: RecordEntry = {
      id: null,
      path,
      state: null,
      valid: true,
      reasons: [],
      supersededBy: null,
      data: null,
      assets: [],
      warnings: [],
      digest: recordTextDigest(text, kind.reviews?.field ?? null, kind.format),
    };
    entries.push(entry);
    if (kind.session) texts.set(path, text);
    const fm = parseRecord(kind.format, text);
    if (!fm.ok) {
      entry.reasons.push({ code: "record-unparseable", message: fm.message });
      continue;
    }
    entry.data = fm.value;
    if (kind.idFrom === "sha256") {
      // The id is the hash of the bytes; the name's stem is the hash it claims.
      // A name that claims another is the record pinning itself, drifted (ws-053).
      entry.id = sha256Hex(options.source.bytes(path));
      const stem = nameStem(path);
      if (stem !== entry.id) {
        const self = workspaceRoot === "." ? path : path.startsWith(`${workspaceRoot}/`) ? path.slice(workspaceRoot.length + 1) : path;
        if (SHA256_HEX.test(stem)) entry.assets.push({ path: self, sha256: stem, actual: entry.id, state: "drifted" });
        entry.warnings.push({
          code: "asset-drift",
          message: SHA256_HEX.test(stem)
            ? `${self} is named for sha256 ${stem.slice(0, 12)}, and its bytes${options.source.label} hash to ${entry.id.slice(0, 12)}`
            : `${self} is content-addressed, and its name claims no sha256: its bytes${options.source.label} hash to ${entry.id.slice(0, 12)}`,
        });
      }
    } else {
      const id = fm.value[kind.idField!];
      if (typeof id === "string") entry.id = id;
    }
    const state = kind.stateField === undefined ? undefined : fm.value[kind.stateField];
    if (typeof state === "string") entry.state = state;
    const result = validate(fm.value);
    if (!result.ok) {
      entry.reasons.push({ code: "record-schema-invalid", message: result.errors.join("; ") });
    }
    if (kind.pins) {
      const cited = fm.value[kind.pins.field];
      if (Array.isArray(cited) && cited.length === 0) {
        entry.warnings.push({ code: "record-no-evidence", message: `${kind.pins.field} is empty: the record cites nothing and pins no file` });
      }
      if (options.assets) {
        const checked = checkPins(pinEntries(fm.value, kind.pins.field), options.assets);
        entry.assets.push(...checked.assets);
        entry.warnings.push(...checked.warnings);
      }
    }
    if (kind.reviews) {
      const list = fm.value[kind.reviews.field];
      const undigested = (Array.isArray(list) ? list : [])
        .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r) && (r as Record<string, unknown>).digest === undefined)
        .map((r) => (typeof r.reviewer === "string" ? r.reviewer : "an unnamed reviewer"));
      if (undigested.length > 0) {
        entry.warnings.push({
          code: "review-undigested",
          message: `the ${undigested.length === 1 ? "verdict" : "verdicts"} by ${undigested.join(", ")} name no digest: ${undigested.length === 1 ? "it counts" : "they count"}, and an amendment will not stop ${undigested.length === 1 ? "it" : "them"} counting`,
        });
      }
    }
  }

  // Ids: the first file in path order keeps an id; later ones are flagged.
  const byId = new Map<string, RecordEntry>();
  for (const e of entries) {
    if (e.id === null) continue;
    const first = byId.get(e.id);
    if (first) e.reasons.push({ code: "record-id-duplicate", message: `id ${e.id} is already used by ${first.path}` });
    else byId.set(e.id, e);
  }

  // Supersession comes from the new record's links, never from the old record.
  // With approval ranks, a link takes effect under an equal or stricter
  // approval rule: from a record ranked above 0 and at least as high as the
  // one it names (#2524 D4). Without them, only from a closed record (#2555).
  // A record is superseded at most once.
  const closed = new Set(kind.closedStates ?? []);
  const rank = (state: string | null): number => (state === null ? 0 : (kind.approval?.[state] ?? 0));
  const takesEffect = (from: RecordEntry, to: RecordEntry): boolean =>
    kind.approval ? rank(from.state) > 0 && rank(from.state) >= rank(to.state) : from.state !== null && closed.has(from.state);
  for (const e of entries) {
    for (const target of supersedesTargets(kind, e.data)) {
      const old = byId.get(target);
      if (!old) {
        e.reasons.push({ code: "record-supersedes-unknown", message: `supersedes ${target}, which no record has` });
        continue;
      }
      if (old === e) continue;
      if (!takesEffect(e, old)) {
        if (kind.approval) {
          e.warnings.push({
            code: "record-supersedes-pending",
            message: `supersedes ${target}, which is ${old.state ?? "stateless"}; a ${e.state ?? "stateless"} record can't supersede it, so the link takes effect once this record is approved at least as strongly`,
          });
        }
        continue;
      }
      if (old.supersededBy !== null && old.supersededBy !== e.id) {
        e.reasons.push({
          code: "record-supersedes-conflict",
          message: `supersedes ${target}, which ${old.supersededBy} already supersedes`,
        });
        continue;
      }
      old.supersededBy = e.id;
    }
  }

  // A pin that still matches, at the hash a record this one supersedes
  // pinned, while the file has not changed since this record was recorded:
  // the decision moved on and the artifact did not (#2549).
  for (const e of entries) {
    for (const a of e.assets) {
      if (a.state !== "pinned") continue;
      const old = entries.find((o) => o.supersededBy !== null && o.supersededBy === e.id && o.assets.some((p) => p.path === a.path && p.sha256 === a.sha256));
      if (!old) continue;
      const changed = options.history?.fileChanged(a.path) ?? null;
      const recorded = options.history ? options.history.recorded(e.path) : null;
      // A record not yet committed is recorded now, after every commit.
      if (changed !== null && recorded !== null && changed > recorded) continue;
      a.state = "stale";
      e.warnings.push({
        code: "asset-stale",
        message: `${a.path} is pinned at the hash ${old.id} pinned, and it has not changed since: ${e.id} supersedes ${old.id}, and the artifact did not follow`,
      });
    }
  }

  // A session's seal and its verdicts' records (#2673).
  joinSessions(kind, entries, texts, options.subjects ?? null);

  for (const e of entries) e.valid = e.reasons.length === 0;
  const records = options.current ? entries.filter((e) => e.supersededBy === null) : entries;
  return {
    records,
    summary: {
      total: records.length,
      valid: records.filter((e) => e.valid).length,
      invalid: records.filter((e) => !e.valid).length,
      superseded: entries.filter((e) => e.supersededBy !== null).length,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join(posix.sep);
}
