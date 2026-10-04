/**
 * `chant workspace records close <session id>` (#2693): close a review
 * session in one write. It sets the session's state to its kind's closed
 * state, the time it closed and the commit it closed at (the fields the
 * kind's `session` block names in `closedOn` and `closedRev`), and then the
 * seal by chant's whole-file rule ({@link sessionSeal}, #2546), so a UI never
 * computes a seal.
 *
 * Like `new`, `amend` and `review`, it reads the records again with the file
 * in place and writes only when the session comes back valid: a verdict
 * naming a record the subjects lack is refused with
 * `session-verdict-unknown-record`. A session already closed is
 * `record-closed`. It writes one file or none and never commits. Like them
 * it holds the working tree's write lock, and takes `--expect <digest>`
 * (#3173).
 */

import type { ReasonCode } from "./reason-codes";
import { sessionSeal } from "./record-sessions";
import { RECORD_REASON_CODES } from "./records";
import {
  abs,
  failure,
  findRecord,
  LOAD_ERROR_CODES,
  open,
  openedRevFill,
  readAll,
  RECORDS_WRITE_CONTRACT_VERSION,
  RecordWriteError,
  refuseOutOfScope,
  refuseStale,
  replaceFields,
  stableJson,
  validatedEntry,
  writeWho,
  type WriteFailure,
  type WriteResult,
} from "./records-write";
import { noteWrites, withWriteLock, writeFileAtomic, WRITE_LOCK_CODES } from "./write-lock";
import { headCommit } from "./session-kinds";
import { WRITE_SCOPE_CODES } from "./write-scope";

export const RECORDS_CLOSE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/records-close/v1/records-close.schema.json";

/** Why `records close` wrote nothing. Closed. */
export const CLOSE_ERROR_CODES = [
  ...LOAD_ERROR_CODES,
  "write-usage-invalid",
  "record-not-found",
  "record-closed",
  "record-conflict",
  ...WRITE_LOCK_CODES,
  ...WRITE_SCOPE_CODES,
  ...RECORD_REASON_CODES,
] as const satisfies readonly ReasonCode[];
export type CloseErrorCode = (typeof CLOSE_ERROR_CODES)[number];

export type CloseDocument =
  | (WriteResult & {
      /** The top-level fields the close set, in the order written. */
      changed: string[];
      /** The seal field and the digest written in it. */
      seal: { field: string; digest: string };
      /** The commit HEAD named at the close, or null outside git or before the first commit. */
      closedRev: string | null;
    })
  | WriteFailure<CloseErrorCode>;

export interface CloseRecordOptions {
  /** The session kind file, resolved against `cwd`. */
  kind: string;
  id: string;
  dryRun?: boolean;
  cwd: string;
  /** The close time. Defaults to now. */
  now?: Date;
  /** The agent session the write is made in (#2548). */
  agent?: string;
  /** The session's digest the caller last read (#3173): the close is refused with record-conflict when it has another. */
  expect?: string;
}

/** An ISO 8601 time in UTC to the second, as the reference session schema's dateTime takes it. */
function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `records close`: close one open session and seal it, holding the write lock (#3173). */
export async function closeRecord(opts: CloseRecordOptions): Promise<CloseDocument> {
  try {
    if (opts.expect !== undefined && !/^[0-9a-f]{64}$/.test(opts.expect)) {
      throw new RecordWriteError("write-usage-invalid", `--expect takes a record's digest, 64 lowercase hex digits as records --json prints it, not ${JSON.stringify(opts.expect)}`);
    }
    return await withWriteLock(opts.cwd, writeWho("records close", opts), opts.dryRun, () => closeRecordLocked(opts));
  } catch (err) {
    return failure<CloseErrorCode>(RECORDS_CLOSE_SCHEMA_ID, err);
  }
}

async function closeRecordLocked(opts: CloseRecordOptions): Promise<CloseDocument> {
  try {
    const o = await open(opts.kind, opts.cwd);
    refuseOutOfScope(o, "close", opts.cwd, opts);
    const { kind } = o.loaded;
    const decl = kind.session;
    if (!decl || kind.stateField === undefined) {
      throw new RecordWriteError("write-usage-invalid", `the ${kind.name} kind has no session block, and records close closes a review session; amend sets the state of other records`);
    }
    const closedState = (kind.closedStates ?? [])[0];
    if (closedState === undefined) throw new RecordWriteError("write-usage-invalid", `the ${kind.name} kind lists no closed state, so a session of it can't close`);
    const before = await readAll(o, o.source);
    const target = findRecord(before, opts.id, kind.name);
    refuseStale(o, target, opts.id, opts.expect);
    if (target.state !== null && (kind.closedStates ?? []).includes(target.state)) {
      throw new RecordWriteError("record-closed", `${opts.id} is already ${target.state}, and a closed session is sealed and stays as it is`);
    }
    if (target.data === null) throw new RecordWriteError("record-unparseable", `${target.path} can't be read, so it can't be closed`);
    const old = target.data;
    const closedRev = headCommit(o.root);
    const set: Record<string, unknown> = {
      ...openedRevFill(kind, old, o.root),
      [kind.stateField]: closedState,
      ...(decl.closedOn ? { [decl.closedOn]: isoSeconds(opts.now ?? new Date()) } : {}),
      ...(decl.closedRev ? { [decl.closedRev]: closedRev } : {}),
    };
    // The seal is written last, into text that already holds everything else: the whole-file seal of the session without its seal field (#2546).
    const merged = { ...old, ...set };
    delete merged[decl.seal];
    const unsealed = replaceFields(o.source.read(target.path), set, merged);
    if (unsealed === undefined) throw new RecordWriteError("record-unparseable", `${target.path}: its fields can't be rewritten in place without changing the rest of the file`);
    const digest = sessionSeal(unsealed, decl.seal, kind.format);
    if (digest === null) throw new RecordWriteError("record-unparseable", `${target.path} can't be read, so it can't be sealed`);
    const text = replaceFields(unsealed, { [decl.seal]: digest }, { ...merged, [decl.seal]: digest });
    if (text === undefined || sessionSeal(text, decl.seal, kind.format) !== digest) {
      throw new RecordWriteError("record-unparseable", `${target.path}: the ${decl.seal} line can't be added without changing the text it seals`);
    }
    const entry = await validatedEntry(o, before, target.path, text);
    if (!opts.dryRun) {
      writeFileAtomic(abs(o, target.path), text);
      noteWrites(o.root, [{ path: target.path, text }], writeWho("records close", opts));
    }
    const written = { ...merged, [decl.seal]: digest };
    return {
      $schema: RECORDS_CLOSE_SCHEMA_ID,
      contract: RECORDS_WRITE_CONTRACT_VERSION,
      kind: o.view,
      path: target.path,
      id: opts.id,
      changed: Object.keys(written).filter((k) => stableJson(old[k]) !== stableJson(written[k])),
      seal: { field: decl.seal, digest },
      closedRev,
      dryRun: !!opts.dryRun,
      warnings: entry.warnings,
      digest: entry.digest,
      ...(opts.dryRun ? { text } : {}),
    };
  } catch (err) {
    return failure<CloseErrorCode>(RECORDS_CLOSE_SCHEMA_ID, err);
  }
}
