/**
 * Records read through a record kind (#2524 D4), first-test slice (#2546).
 *
 * A record kind is data. It says where its records live, which JSON Schema
 * they follow and which of their states are closed. This module reads every
 * record a kind locates, parses its front matter as the JSON subset of YAML,
 * validates it against the kind's schema and derives supersession from the
 * records' own `supersedes` links. It never writes a record.
 *
 * A record that fails any of that is still returned, with reason codes, and the
 * read succeeds. Only a failure to read the kind, its schema or the revision is
 * an error. Seals, attestation and the workspace declaration come later (#2546,
 * #2534); nothing here needs a `chant.workspace.json`.
 *
 * Everything under `workspace/` loads only when a `chant workspace` command
 * runs. The level-0 goldens (#2526) fail if a level-0 command loads it.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { importLexiconModule, registerLexiconDeclarations } from "../lexicon-module";
import type { ReasonCode } from "./reason-codes";
import { checkPins, pinEntries, type AssetPin } from "./record-assets";
import type { RecordSource } from "./record-source";
import type { WorkspaceTree } from "./tree";

// ── Reason codes ─────────────────────────────────────────────────────────────

/**
 * Why one record is not valid. The list is closed: a reader may switch on it,
 * and a new code is a contract change (#2536).
 */
export const RECORD_REASON_CODES = [
  /** No front matter, a YAML error, or a value outside the JSON subset of YAML. */
  "record-unparseable",
  /** The front matter does not match the kind's schema. */
  "record-schema-invalid",
  /** Another record earlier in path order has the same id. */
  "record-id-duplicate",
  /** A `supersedes` link names an id no record has. */
  "record-supersedes-unknown",
  /** A second closed record supersedes a record another one already superseded. */
  "record-supersedes-conflict",
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
] as const satisfies readonly ReasonCode[];
export type RecordWarningCode = (typeof RECORD_WARNING_CODES)[number];

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
    /** Only Markdown with YAML front matter for now. */
    format: z.literal("markdown-front-matter"),
    schema: z
      .object({
        /** The schema's `$id`. A schema file with a different `$id` is refused. */
        id: z.string().min(1),
        /** The schema file, relative to the kind file's directory. */
        path: z.string().min(1),
      })
      .strict(),
    /** The front-matter field holding the record's id. */
    idField: z.string().min(1),
    /** The front-matter field holding the record's state. */
    stateField: z.string().min(1),
    states: z.array(z.string().min(1)).min(1),
    /** States whose records are final. A `supersedes` link takes effect only from a record in one of them. */
    closedStates: z.array(z.string().min(1)),
    /** The front-matter list of links to superseded records, and the key in each entry that holds the target id. */
    supersedes: z.object({ field: z.string().min(1), key: z.string().min(1) }).strict(),
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
  })
  .strict()
  .refine((k) => k.closedStates.every((s) => k.states.includes(s)), {
    message: "every closed state must be listed in states",
    path: ["closedStates"],
  })
  .refine((k) => Object.keys(k.approval ?? {}).every((s) => k.states.includes(s)), {
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
  const schemaFile = resolve(base, kind.schema.path);
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(readFileSync(schemaFile, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new RecordReadError("schema-unreadable", `schema ${kind.schema.path} named by ${path} could not be read: ${message(err)}`);
  }
  if (schema.$id !== kind.schema.id) {
    throw new RecordReadError(
      "schema-id-mismatch",
      `kind ${kind.name} names schema ${kind.schema.id}, but ${kind.schema.path} has $id ${JSON.stringify(schema.$id)}`,
    );
  }
  return { kind, file, dir: resolve(base, kind.location.dir), schema };
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
  /** The front matter as JSON, or null when it could not be parsed. */
  data: Record<string, unknown> | null;
  /** Each workspace file the record pins, checked against the tree read (#2549). Empty when nothing was checked. */
  assets: AssetPin[];
  /** Findings that leave the record valid, such as a pinned file that changed (#2549). */
  warnings: RecordWarning[];
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

async function compileSchema(schema: Record<string, unknown>): Promise<Validator> {
  const mod = (await import("ajv")) as unknown as { default: unknown };
  // ajv is CommonJS; its class is the default export, or that export's own default.
  const Ajv = ((mod.default as { default?: unknown }).default ?? mod.default) as new (opts: object) => {
    compile(s: object): ((d: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
  };
  let validate: ReturnType<InstanceType<typeof Ajv>["compile"]>;
  try {
    validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  } catch (err) {
    throw new RecordReadError("schema-invalid", `the kind's schema does not compile: ${message(err)}`);
  }
  return (data) =>
    validate(data)
      ? { ok: true }
      : { ok: false, errors: (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`) };
}

/** Read every record `loaded` locates, through `options.source`. */
export async function readRecords(loaded: LoadedRecordKind, options: ReadRecordsOptions): Promise<ReadRecordsResult> {
  const { kind } = loaded;
  const dirRel = toPosix(relative(options.root, loaded.dir)) || ".";
  const names = options.source.list(dirRel);
  if (names === undefined) {
    throw new RecordReadError("location-missing", `records directory ${dirRel} does not exist${options.source.label}`);
  }
  const match = new RegExp(kind.location.match);
  const validate = await compileSchema(loaded.schema);

  const entries: RecordEntry[] = [];
  for (const name of names.filter((n) => match.test(n)).sort()) {
    const path = dirRel === "." ? name : `${dirRel}/${name}`;
    const entry: RecordEntry = { id: null, path, state: null, valid: true, reasons: [], supersededBy: null, data: null, assets: [], warnings: [] };
    entries.push(entry);
    const fm = parseFrontMatter(options.source.read(path));
    if (!fm.ok) {
      entry.reasons.push({ code: "record-unparseable", message: fm.message });
      continue;
    }
    entry.data = fm.value;
    const id = fm.value[kind.idField];
    const state = fm.value[kind.stateField];
    if (typeof id === "string") entry.id = id;
    if (typeof state === "string") entry.state = state;
    const result = validate(fm.value);
    if (!result.ok) {
      entry.reasons.push({ code: "record-schema-invalid", message: result.errors.join("; ") });
    }
    if (kind.pins && options.assets) {
      const checked = checkPins(pinEntries(fm.value, kind.pins.field), options.assets);
      entry.assets = checked.assets;
      entry.warnings = checked.warnings;
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
  const closed = new Set(kind.closedStates);
  const rank = (state: string | null): number => (state === null ? 0 : (kind.approval?.[state] ?? 0));
  const takesEffect = (from: RecordEntry, to: RecordEntry): boolean =>
    kind.approval ? rank(from.state) > 0 && rank(from.state) >= rank(to.state) : from.state !== null && closed.has(from.state);
  for (const e of entries) {
    const links = e.data?.[kind.supersedes.field];
    if (!Array.isArray(links)) continue;
    for (const link of links) {
      if (link === null || typeof link !== "object") continue;
      const target = (link as Record<string, unknown>)[kind.supersedes.key];
      if (typeof target !== "string") continue;
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
