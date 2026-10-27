/**
 * The control repo's entries (#4568): its projects and its shared defaults,
 * as `control-entry` records on the control repo's workspace ledger.
 *
 * terragucci kept these as `chant workspace records` files committed to the
 * control repo (packages/terragucci/src/control-records.ts at 18f6431595).
 * Under the ci-products ruling (records go on the ledger, never product git
 * writes; #4551) they are lines of `_control/entries.jsonl` on the control
 * repo's `chant/lifecycle` branch, appended through the same git layer every
 * other ledger here uses, under the member prefix of the directory they are
 * written from.
 *
 * The file is a log. Each line is one version of one entry: a project's
 * (`entry: project`, `project: <host>/<owner>/<name>`) or the defaults'
 * (`entry: defaults`). An entry's current version is its newest line; a
 * `retired` version closes it, and a project that comes back gets a new id.
 * Each line names the digest of the version it replaces (`prev`), so a write
 * that raced another is refused rather than lost, as terragucci's `amend
 * --expect` refused it, and a reader finds a broken chain.
 *
 * What an entry's `settings` hold is the product's: chant checks the shape
 * of the record, and the product passes a `validate` that checks its
 * settings the way its config would.
 *
 * Neither write pushes: call `pushLifecycleReport` after, the two-step shape
 * every ledger here uses.
 */

import { createHash } from "node:crypto";
import { parseProjectKey } from "./dispatch";

/** The ledger directory and file the entries are kept in. */
export const CONTROL_LEDGER_DIR = "_control";
export const CONTROL_LEDGER_FILE = "entries.jsonl";

/** The record kind, as each line names it. */
export const CONTROL_ENTRY_KIND = "control-entry";
/** The prefix of an entry's id: `ctl-001`. */
export const CONTROL_ID_PREFIX = "ctl";

export const CONTROL_ENTRY_KINDS = ["project", "defaults"] as const;
export type ControlEntryKind = (typeof CONTROL_ENTRY_KINDS)[number];
export type ControlEntryState = "active" | "retired";

/** One line of `_control/entries.jsonl`: one version of one entry. */
export interface ControlEntryRecord {
  version: 1;
  kind: typeof CONTROL_ENTRY_KIND;
  /** `ctl-<n>`, three digits or more. */
  id: string;
  entry: ControlEntryKind;
  /** The project's key; null for the defaults. */
  project: string | null;
  state: ControlEntryState;
  /** The project's settings, or the defaults, as the product's config holds them. */
  settings: Record<string, unknown>;
  /** The estates this project owns. Empty for the defaults. */
  estates: string[];
  /** The product that wrote it: `terragucci`, `plywood`. */
  product: string;
  /** When it was written, ISO 8601. */
  at: string;
  /** Who wrote it, when known. */
  by?: string;
  /** The digest of the version this one replaces; null for an entry's first. */
  prev: string | null;
  /** sha256 over the canonical JSON of every other field. */
  digest: string;
}

/** An entry's current version, as a product reads it. */
export interface ControlEntry {
  id: string;
  entry: ControlEntryKind;
  /** The project's key; undefined for the defaults. */
  project?: string;
  settings: Record<string, unknown>;
  estates: string[];
  digest: string;
  at: string;
  by?: string;
}

/** Records the control repo's entries are wrong in; `problems` lists each one. */
export class ControlRecordsError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [message],
  ) {
    super(message);
    this.name = "ControlRecordsError";
  }
}

/** A write refused because the entry changed since it was read. */
export class ControlEntryConflict extends ControlRecordsError {
  constructor(message: string) {
    super(message);
    this.name = "ControlEntryConflict";
  }
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/** The digest of a record: sha256 over the canonical JSON of every field but `digest`. */
export function controlEntryDigest(record: Omit<ControlEntryRecord, "digest">): string {
  const { digest: _drop, ...rest } = record as ControlEntryRecord;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(rest))).digest("hex")}`;
}

const ID = new RegExp(`^${CONTROL_ID_PREFIX}-[0-9]{3,}$`);

/** The problems with one parsed line, or [] when it is a record. */
export function controlEntryRecordProblems(v: unknown): string[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return ["not an object"];
  const r = v as Record<string, unknown>;
  const out: string[] = [];
  if (r.version !== 1) out.push("version must be 1");
  if (r.kind !== CONTROL_ENTRY_KIND) out.push(`kind must be ${CONTROL_ENTRY_KIND}`);
  if (!(typeof r.id === "string" && ID.test(r.id))) out.push(`id must be ${CONTROL_ID_PREFIX}-<three digits or more>`);
  if (!CONTROL_ENTRY_KINDS.includes(r.entry as ControlEntryKind)) out.push("entry must be project or defaults");
  if (r.entry === "project" && !(typeof r.project === "string" && r.project.length > 0)) out.push("a project entry names its project");
  if (r.entry === "defaults" && r.project !== null) out.push("the defaults name no project");
  if (r.state !== "active" && r.state !== "retired") out.push("state must be active or retired");
  if (typeof r.settings !== "object" || r.settings === null || Array.isArray(r.settings)) out.push("settings must be an object");
  if (!(Array.isArray(r.estates) && r.estates.every((e) => typeof e === "string" && e.length > 0) && new Set(r.estates).size === r.estates.length)) out.push("estates must be distinct names");
  if (r.entry === "defaults" && Array.isArray(r.estates) && r.estates.length > 0) out.push("the defaults own no estates");
  if (!(typeof r.product === "string" && r.product.length > 0)) out.push("product must name the product that wrote it");
  if (!(typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)))) out.push("at must be a time");
  if (r.by !== undefined && typeof r.by !== "string") out.push("by must be a string");
  if (!(r.prev === null || typeof r.prev === "string")) out.push("prev must be a digest or null");
  if (typeof r.digest !== "string") out.push("digest is missing");
  else if (out.length === 0 && controlEntryDigest(r as unknown as ControlEntryRecord) !== r.digest) out.push("digest does not match the record");
  return out;
}

/** Every line of the file, each a record or the problems that kept it out. */
export function parseControlEntries(text: string | null | undefined): { records: ControlEntryRecord[]; malformed: Array<{ line: number; problems: string[] }> } {
  const records: ControlEntryRecord[] = [];
  const malformed: Array<{ line: number; problems: string[] }> = [];
  (text ?? "").split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      malformed.push({ line: i + 1, problems: ["not JSON"] });
      return;
    }
    const problems = controlEntryRecordProblems(v);
    if (problems.length > 0) malformed.push({ line: i + 1, problems });
    else records.push(v as ControlEntryRecord);
  });
  return { records, malformed };
}

/** The key an entry is one of: its project, or `defaults`. */
function keyOf(r: Pick<ControlEntryRecord, "entry" | "project">): string {
  return r.entry === "defaults" ? "defaults" : r.project!;
}

/**
 * Each entry's current version from the log, oldest first: the newest line
 * of each id, left out when it is retired. A version whose `prev` is not the
 * digest of the one before it, or two active ids for one project (or for
 * the defaults), is a problem.
 */
export function currentControlEntries(records: readonly ControlEntryRecord[]): { entries: ControlEntry[]; problems: string[] } {
  const problems: string[] = [];
  const newest = new Map<string, ControlEntryRecord>();
  for (const r of records) {
    const before = newest.get(r.id);
    if ((before?.digest ?? null) !== r.prev) problems.push(`${r.id} at ${r.at} replaces ${r.prev ?? "nothing"}, but its version before was ${before?.digest ?? "none"}`);
    if (before && keyOf(before) !== keyOf(r)) problems.push(`${r.id} moved from ${keyOf(before)} to ${keyOf(r)}; an id keeps its project`);
    newest.set(r.id, r);
  }
  const entries: ControlEntry[] = [];
  const byKey = new Map<string, string>();
  for (const r of newest.values()) {
    if (r.state === "retired") continue;
    const key = keyOf(r);
    const prior = byKey.get(key);
    if (prior) problems.push(`${key} has two active entries, ${prior} and ${r.id}; retire one`);
    else byKey.set(key, r.id);
    if (r.entry === "project") {
      try {
        parseProjectKey(r.project!);
      } catch (e) {
        problems.push(`${r.id}: ${(e as Error).message}`);
      }
    }
    entries.push({
      id: r.id,
      entry: r.entry,
      ...(r.project !== null ? { project: r.project } : {}),
      settings: r.settings,
      estates: r.estates,
      digest: r.digest,
      at: r.at,
      ...(r.by !== undefined ? { by: r.by } : {}),
    });
  }
  return { entries, problems };
}

/**
 * Where the entries are read from and appended to. {@link gitControlLedger}
 * is the control repo's `chant/lifecycle`; a test passes one in memory.
 */
export interface ControlLedgerPort {
  /** The file's text, or null when the branch or the file is absent. */
  read(): Promise<string | null>;
  /** Append one line, committed with `message`. Returns the commit. Does not push. */
  append(line: string, message: string): Promise<string>;
}

/** The control repo's `_control/entries.jsonl` on its local `chant/lifecycle`, under the member prefix of `cwd`. */
export function gitControlLedger(opts: { cwd?: string } = {}): ControlLedgerPort {
  return {
    async read() {
      const { readBlobFromPath } = await import("../lifecycle/git");
      return readBlobFromPath(CONTROL_LEDGER_DIR, CONTROL_LEDGER_FILE, opts);
    },
    async append(line, message) {
      const { appendLedgerLine } = await import("../lifecycle/git");
      return appendLedgerLine(CONTROL_LEDGER_DIR, CONTROL_LEDGER_FILE, line, message, opts);
    },
  };
}

/** Checks one entry's settings the way the product's config would; returns the problems. */
export type ControlSettingsValidator = (entry: ControlEntryKind, project: string | undefined, settings: Record<string, unknown>) => string[];

/** What a read takes. */
export interface ReadControlEntriesOptions {
  /** The product's check of each entry's settings. */
  validate?: ControlSettingsValidator;
  /** Read past malformed lines rather than refuse. Default false. */
  lenient?: boolean;
}

/** The control repo's current entries, each checked. A problem anywhere refuses the read, unless `lenient`. */
export async function readControlEntries(port: ControlLedgerPort, opts: ReadControlEntriesOptions = {}): Promise<ControlEntry[]> {
  const { records, malformed } = parseControlEntries(await port.read());
  const { entries, problems } = currentControlEntries(records);
  const all = [...malformed.map((m) => `${CONTROL_LEDGER_DIR}/${CONTROL_LEDGER_FILE}:${m.line}: ${m.problems.join(", ")}`), ...problems];
  if (opts.validate) for (const e of entries) for (const p of opts.validate(e.entry, e.project, e.settings)) all.push(`${e.id} (${e.project ?? "defaults"}): ${p}`);
  if (all.length > 0 && !opts.lenient) throw new ControlRecordsError(`the control repo's entries have ${all.length} problem(s):\n  ${all.join("\n  ")}`, all);
  return entries;
}

/** The entries as a product's control config holds them: the defaults, and each project's settings by key. */
export function controlConfig(entries: readonly ControlEntry[]): { defaults?: Record<string, unknown>; projects: Record<string, Record<string, unknown>> } {
  const defaults = entries.find((e) => e.entry === "defaults");
  const projects: Record<string, Record<string, unknown>> = {};
  for (const e of entries.filter((x) => x.entry === "project").sort((a, b) => a.project!.localeCompare(b.project!))) projects[e.project!] = e.settings;
  return { ...(defaults ? { defaults: defaults.settings } : {}), projects };
}

/** Who claims each estate in the entries: estate name to project keys. Read at each plan; nothing is kept between plans. */
export function estateClaims(entries: readonly ControlEntry[]): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  for (const e of entries) {
    if (e.entry !== "project") continue;
    for (const estate of e.estates) claims.set(estate, [...(claims.get(estate) ?? []), e.project!]);
  }
  return claims;
}

/** What a write takes besides the entry. */
export interface ControlWriteOptions {
  /** The product writing it. */
  product: string;
  by?: string;
  validate?: ControlSettingsValidator;
  /** The digest the caller read the entry at. A write over a different current version is refused. */
  expect?: string;
  /** Build the line and check it, append nothing. */
  dryRun?: boolean;
  /** The clock. Default now. */
  now?: () => Date;
}

/** One write's outcome. */
export interface ControlPutResult {
  id: string;
  /** created: a new entry. updated: a new version of the active one. unchanged: it already held these settings. retired: closed. */
  status: "created" | "updated" | "unchanged" | "retired";
  /** The version written, or the current one when unchanged. */
  record?: ControlEntryRecord;
  /** The ledger commit, when one was written. */
  commit?: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function nextId(records: readonly ControlEntryRecord[]): string {
  const n = records.reduce((max, r) => Math.max(max, Number(r.id.slice(CONTROL_ID_PREFIX.length + 1))), 0) + 1;
  return `${CONTROL_ID_PREFIX}-${String(n).padStart(3, "0")}`;
}

async function writeVersion(port: ControlLedgerPort, fields: Omit<ControlEntryRecord, "digest">, opts: ControlWriteOptions, message: string): Promise<{ record: ControlEntryRecord; commit?: string }> {
  const record: ControlEntryRecord = { ...fields, digest: controlEntryDigest(fields) };
  const problems = controlEntryRecordProblems(record);
  if (problems.length > 0) throw new ControlRecordsError(`not a control entry: ${problems.join(", ")}`, problems);
  if (opts.dryRun) return { record };
  return { record, commit: await port.append(JSON.stringify(record), message) };
}

/**
 * Creates the project's (or the defaults') entry, or writes a new version
 * of the active one. With `expect`, a current version whose digest differs
 * is refused ({@link ControlEntryConflict}). `estates` left out keeps the
 * entry's.
 */
export async function putControlEntry(
  port: ControlLedgerPort,
  want: { entry: ControlEntryKind; project?: string; settings: Record<string, unknown>; estates?: string[] },
  opts: ControlWriteOptions,
): Promise<ControlPutResult> {
  if (want.entry === "project" && !want.project) throw new ControlRecordsError("a project entry needs the project's key");
  if (want.entry === "defaults" && (want.project || want.estates?.length)) throw new ControlRecordsError("the defaults take no project key and own no estates");
  if (want.entry === "project") parseProjectKey(want.project!);
  const problems = opts.validate?.(want.entry, want.project, want.settings) ?? [];
  if (problems.length > 0) throw new ControlRecordsError(`${want.project ?? "defaults"}: ${problems.join("; ")}`, problems);
  const { records, malformed } = parseControlEntries(await port.read());
  if (malformed.length > 0) throw new ControlRecordsError(`the control repo's entries have malformed lines (${malformed.map((m) => m.line).join(", ")}); fix them before writing`);
  const { entries } = currentControlEntries(records);
  const key = want.entry === "defaults" ? "defaults" : want.project!;
  const current = entries.find((e) => (want.entry === "defaults" ? e.entry === "defaults" : e.project === want.project));
  if (opts.expect !== undefined && opts.expect !== (current?.digest ?? "")) {
    throw new ControlEntryConflict(`${key} changed since it was read (now ${current?.digest ?? "absent"}, read at ${opts.expect || "absent"}); read it again`);
  }
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const base = { version: 1 as const, kind: CONTROL_ENTRY_KIND as typeof CONTROL_ENTRY_KIND, product: opts.product, at, ...(opts.by !== undefined ? { by: opts.by } : {}) };
  if (!current) {
    const out = await writeVersion(
      port,
      { ...base, id: nextId(records), entry: want.entry, project: want.project ?? null, state: "active", settings: want.settings, estates: want.estates ?? [], prev: null },
      opts,
      `Control entry ${key} created`,
    );
    return { id: out.record.id, status: "created", ...out };
  }
  const estates = want.estates ?? current.estates;
  if (same(current.settings, want.settings) && same(current.estates, estates)) return { id: current.id, status: "unchanged" };
  const out = await writeVersion(
    port,
    { ...base, id: current.id, entry: current.entry, project: current.project ?? null, state: "active", settings: want.settings, estates, prev: current.digest },
    opts,
    `Control entry ${key} updated`,
  );
  return { id: current.id, status: "updated", ...out };
}

/** Retires a project's active entry: the closed state, so the project is no longer read. */
export async function retireControlEntry(port: ControlLedgerPort, project: string, opts: ControlWriteOptions): Promise<ControlPutResult> {
  const { records } = parseControlEntries(await port.read());
  const current = currentControlEntries(records).entries.find((e) => e.project === project);
  if (!current) throw new ControlRecordsError(`no active entry for ${project} in the control repo`);
  if (opts.expect !== undefined && opts.expect !== current.digest) throw new ControlEntryConflict(`${project} changed since it was read; read it again`);
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const out = await writeVersion(
    port,
    { version: 1, kind: CONTROL_ENTRY_KIND, id: current.id, entry: "project", project, state: "retired", settings: current.settings, estates: current.estates, product: opts.product, at, ...(opts.by !== undefined ? { by: opts.by } : {}), prev: current.digest },
    opts,
    `Control entry ${project} retired`,
  );
  return { id: current.id, status: "retired", ...out };
}

/**
 * Writes a control config (the defaults and each project's settings) as
 * entries: one per project and one for the defaults. Moves a control repo
 * off a config file, or off terragucci's record files, onto the ledger.
 */
export async function importControlConfig(
  port: ControlLedgerPort,
  config: { defaults?: Record<string, unknown>; projects: Record<string, Record<string, unknown>>; estates?: Record<string, string[]> },
  opts: ControlWriteOptions,
): Promise<Array<ControlPutResult & { entry: string }>> {
  if (Object.keys(config.projects).length === 0) throw new ControlRecordsError("only a control repo's config, which lists projects, becomes entries");
  const out: Array<ControlPutResult & { entry: string }> = [];
  const { expect: _one, ...each } = opts;
  if (config.defaults) out.push({ entry: "defaults", ...(await putControlEntry(port, { entry: "defaults", settings: config.defaults }, each)) });
  for (const [project, settings] of Object.entries(config.projects)) {
    const estates = config.estates?.[project];
    out.push({ entry: project, ...(await putControlEntry(port, { entry: "project", project, settings, ...(estates ? { estates } : {}) }, each)) });
  }
  return out;
}
