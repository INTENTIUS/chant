/**
 * `chant workspace work claim|renew|release <id> --holder <name>` (#2732,
 * ws-055): the work lease, who is working on which work item. And `chant
 * workspace work history <id>` (#2785): the item's lease history, each claim
 * and how it ended, a read-contract output (`work-history.schema.json`).
 *
 * The lease itself is `../lifecycle/work-lease.ts`, the operator lease under
 * the key `work/<id>`. This file finds the work item first: in the work kind
 * `--kind` names, or in the one work kind the declaration names that has a
 * record with the id. A claim on an id no work record has is refused, and so
 * is a claim on a closed item (done or dropped); renew and release are not,
 * so a lease can always be given back.
 *
 * The lease lives in the ledger of the member that owns the work kind file
 * (#2524 D7), whatever directory the command runs in: `records --json`
 * reports it from there too.
 *
 * Exit codes: 0 when the lease was written, 2 when it was refused (someone
 * holds it, it expired, another clone got there first), 1 when the command
 * could not run (usage, an unreadable kind, an unknown item).
 */

import { dirname, relative } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { parseDuration } from "../op/duration";
import {
  claimWorkLease,
  leaseHistoryPath,
  listWorkLeases,
  readLeaseHistory,
  releaseWorkLease,
  renewWorkLease,
  workLeaseRef,
  WORK_ITEM_ID_PATTERN,
  type WorkLease,
  type WorkLeaseRefusal,
  type WorkLeaseResult,
  type LeaseHistoryWrite,
  type LeaseHistoryRecord,
  type WorkLeaseState,
} from "../lifecycle/work-lease";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { readerVersion, WorkspaceReadError } from "./declaration";
import { declaredKindFiles, readRecordsFor } from "./records-cli";
import { loadRecordKind, RecordReadError, type LoadedRecordKind, type RecordEntry } from "./records";
import { gitRoot } from "./record-source";
import type { ReasonCode } from "./reason-codes";

/** The version of the `work` output this chant writes. */
export const WORK_LEASE_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the `--json` output, shipped beside this file. */
export const WORK_LEASE_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/work-lease/v1/work-lease.schema.json";

export { WORK_LEASE_REFUSALS } from "../lifecycle/work-lease";

const USAGE = [
  "chant workspace work claim|renew|release <id> --holder <name> [--kind <kind file>] [--ttl <seconds|duration>] [--token <token>] [--outcome <text>] [--note <text>] [--json]",
  "chant workspace work history <id> [--kind <kind file>] [--json]",
].join("\n");

/** Exit code when the lease was refused rather than the command failing. */
export const EXIT_LEASE_REFUSED = 2;

export type WorkVerb = "claim" | "renew" | "release";

/** Why the command could not run. Closed. */
export const WORK_ERROR_CODES = [
  "write-usage-invalid",
  "kind-unreadable",
  "work-kind-missing",
  "work-kind-ambiguous",
  "work-item-unknown",
  "work-item-closed",
  "not-a-git-repository",
] as const satisfies readonly ReasonCode[];
export type WorkErrorCode = (typeof WORK_ERROR_CODES)[number];

interface DocHead {
  $schema: string;
  contract: number;
}

/** What `--json` prints. */
export type WorkLeaseDocument = DocHead &
  (
  | {
      item: string;
      event: WorkVerb;
      /** The work kind file, from the repository root. */
      kind: string;
      ref: string;
      lease: Omit<WorkLease, "item">;
      history: LeaseHistoryWrite;
    }
  | {
      item: string;
      event: WorkVerb;
      kind: string;
      ref: string;
      refused: { code: WorkLeaseRefusal; message: string; heldBy: Omit<WorkLease, "item"> | null };
    }
  | { error: { code: WorkErrorCode; message: string } }
  );

/** Why a work command could not run, with its code. */
export class WorkError extends Error {
  constructor(
    readonly code: WorkErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A work item found by id: its kind, its state, its record, and the repository root its path is from. */
export interface FoundWorkItem {
  loaded: LoadedRecordKind;
  state: string | null;
  record: RecordEntry;
  root: string;
}

/**
 * The work kind holding `id`: the one `kind` names, or the one declared work
 * kind with a record `id`. Throws a {@link WorkError}.
 */
export async function findWorkItem(id: string, cwd: string, kind: string | undefined): Promise<FoundWorkItem> {
  let candidates: string[];
  if (kind !== undefined) {
    candidates = [kind];
  } else {
    try {
      candidates = declaredKindFiles(cwd).map((k) => k.file);
    } catch (err) {
      if (!(err instanceof WorkspaceReadError)) throw err;
      throw new WorkError("work-kind-missing", `${err.code}: ${err.describe()}; without --kind, the declaration names the work kind`);
    }
  }
  const found: FoundWorkItem[] = [];
  let workKinds = 0;
  for (const file of candidates) {
    let loaded: LoadedRecordKind;
    try {
      loaded = await loadRecordKind(file, cwd);
    } catch (err) {
      if (err instanceof RecordReadError && kind !== undefined) throw new WorkError("kind-unreadable", `${err.code}: ${err.message}`);
      if (err instanceof RecordReadError) continue;
      throw err;
    }
    if (!loaded.kind.work) {
      if (kind !== undefined) throw new WorkError("work-kind-missing", `${kind} is the ${loaded.kind.name} kind, which has no work block`);
      continue;
    }
    workKinds++;
    let read;
    try {
      read = await readRecordsFor({ kind: loaded.file, cwd });
    } catch (err) {
      if (err instanceof RecordReadError) throw new WorkError("kind-unreadable", `${err.code}: ${err.message}`);
      throw err;
    }
    const record = read.result.records.find((r) => r.id === id);
    if (record) found.push({ loaded, state: record.state, record, root: read.root });
  }
  if (workKinds === 0) throw new WorkError("work-kind-missing", "the declaration names no work kind; pass --kind <kind file>");
  if (found.length === 0) throw new WorkError("work-item-unknown", `no work record has the id ${id}`);
  if (found.length > 1) throw new WorkError("work-kind-ambiguous", `${found.length} work kinds have a record ${id}; pass --kind <kind file>`);
  return found[0];
}

/** Parse `--ttl`: a whole number of seconds, or a duration such as 10m. */
export function parseTtl(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  return parseDuration(raw);
}

export interface WorkLeaseRequest {
  verb: WorkVerb;
  id: string;
  holder: string;
  cwd: string;
  kind?: string;
  ttlMs?: number;
  token?: string;
  outcome?: string;
  note?: string;
}

/** Run one claim, renew or release and build the document `--json` prints. */
export async function workLease(req: WorkLeaseRequest): Promise<WorkLeaseDocument> {
  const doc = { $schema: WORK_LEASE_OUTPUT_SCHEMA_ID, contract: WORK_LEASE_CONTRACT_VERSION };
  try {
    if (!WORK_ITEM_ID_PATTERN.test(req.id) || req.id.includes("..")) throw new WorkError("write-usage-invalid", `${JSON.stringify(req.id)} is not a work item id`);
    if (!gitRoot(req.cwd)) throw new WorkError("not-a-git-repository", "a work lease is a git ref, and this directory is not in a git repository");
    const { loaded, state, root } = await findWorkItem(req.id, req.cwd, req.kind);
    if (req.verb === "claim" && state !== null && (loaded.kind.closedStates ?? []).includes(state)) {
      throw new WorkError("work-item-closed", `${req.id} is ${state}, a closed state; there is no work left to claim`);
    }
    const leaseCwd = dirname(loaded.file);
    const { prefix } = await resolveMemberLedger(leaseCwd);
    const opts = { cwd: leaseCwd, ...(req.note ? { note: req.note } : {}) };
    let result: WorkLeaseResult;
    if (req.verb === "claim") result = await claimWorkLease(req.id, req.holder, { ...opts, ttlMs: req.ttlMs });
    else if (req.verb === "renew") result = await renewWorkLease(req.id, req.holder, { ...opts, ttlMs: req.ttlMs, token: req.token });
    else result = await releaseWorkLease(req.id, req.holder, { ...opts, token: req.token, outcome: req.outcome });
    const head = { ...doc, item: req.id, event: req.verb, kind: relative(root, loaded.file).split("\\").join("/"), ref: workLeaseRef(req.id, prefix) };
    if (!result.ok) {
      const heldBy = result.heldBy ? strip(result.heldBy) : null;
      return { ...head, refused: { code: result.reason, message: result.message, heldBy } };
    }
    return { ...head, lease: strip(result.lease), history: result.history };
  } catch (err) {
    if (err instanceof WorkError) return { ...doc, error: { code: err.code, message: err.message } };
    throw err;
  }
}

function strip(l: WorkLease): Omit<WorkLease, "item"> {
  return { holder: l.holder, token: l.token, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt };
}

// ── work history (#2785) ────────────────────────────────────────────────────

/** The version of the `work history` output this chant writes: read contract 1. */
export const WORK_HISTORY_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for `work history --json`, shipped beside this file. */
export const WORK_HISTORY_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/work-history/v1/work-history.schema.json";

/** Why `work history` read nothing. Closed. */
export const WORK_HISTORY_ERROR_CODES = [
  "kind-unreadable",
  "work-kind-missing",
  "work-kind-ambiguous",
  "work-item-unknown",
  "not-a-git-repository",
] as const satisfies readonly ReasonCode[];
export type WorkHistoryErrorCode = (typeof WORK_HISTORY_ERROR_CODES)[number];

/**
 * How a claim ended. `released`: its holder, or someone closing out an
 * expired lease, gave it back, with an outcome when one was given. `held`: it
 * is the live lease now. `expired`: it ran out and nobody released it or
 * claimed the item since. `lost`: it ran out unreleased and another claim
 * took the item.
 */
export type ClaimEnd = "released" | "held" | "expired" | "lost";

/** One claim of a work item: one fencing token, from its claim to how it ended. */
export interface LeaseClaim {
  token: string;
  holder: string;
  acquiredAt: string;
  /** The expiry its last claim or renew set. */
  expiresAt: string;
  renewals: number;
  ended: ClaimEnd;
  /** The release, when it was released. */
  release: { by: string; at: string; outcome: string | null; note: string | null } | null;
}

/** What `work history --json` prints. */
export type WorkHistoryDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      item: string;
      /** The work kind file, from the repository root. */
      kind: string;
      /** The lease ref. */
      ref: string;
      /** The history file on the branch, under the member's prefix when the kind's member has one. */
      ledger: { branch: string; path: string };
      /** The lease ref's record now, live or expired, or null when there is none. Read from local refs, without fetching. */
      lease: (Omit<WorkLease, "item"> & { state: "active" | "expired" }) | null;
      /** Each claim, oldest first. */
      claims: LeaseClaim[];
      /** Every line of the history, oldest first. */
      events: LeaseHistoryRecord[];
      /** Lines of the history that are not lease events, left out. */
      malformed: number;
      summary: { claims: number; released: number; held: number; expired: number; lost: number; outcomes: Record<string, number> };
    }
  | { $schema: string; contract: number; chant: string; error: { code: WorkHistoryErrorCode; message: string } };

/** Fold a history into its claims: one per token, in the order they were first seen. */
export function claimsOf(events: LeaseHistoryRecord[], live: Pick<WorkLeaseState, "token" | "state"> | null): LeaseClaim[] {
  const byToken = new Map<string, LeaseClaim>();
  const order: string[] = [];
  for (const e of events) {
    let c = byToken.get(e.token);
    if (!c) {
      c = { token: e.token, holder: e.holder, acquiredAt: e.acquiredAt, expiresAt: e.expiresAt, renewals: 0, ended: "expired", release: null };
      byToken.set(e.token, c);
      order.push(e.token);
    }
    if (e.event === "renew") c.renewals++;
    if (e.event !== "release") c.expiresAt = e.expiresAt;
    if (e.event === "release") c.release = { by: e.by, at: e.timestamp, outcome: e.outcome ?? null, note: e.note ?? null };
  }
  return order.map((token, i) => {
    const c = byToken.get(token)!;
    if (c.release) c.ended = "released";
    else if (live && live.token === token) c.ended = live.state === "active" ? "held" : "expired";
    else if (i < order.length - 1) c.ended = "lost";
    else c.ended = "expired";
    return c;
  });
}

/**
 * Read work item `id`'s lease history (#2785): every claim, renew and release
 * on `_leases/<id>.jsonl` in the ledger of the member owning the work kind,
 * folded into claims. Read from the local `chant/lifecycle` branch and lease
 * refs; it never fetches, like the other read-contract reads.
 */
export async function workHistory(req: { id: string; cwd: string; kind?: string }): Promise<WorkHistoryDocument> {
  const head = { $schema: WORK_HISTORY_OUTPUT_SCHEMA_ID, contract: WORK_HISTORY_CONTRACT_VERSION, chant: readerVersion() };
  try {
    if (!WORK_ITEM_ID_PATTERN.test(req.id) || req.id.includes("..")) throw new WorkError("work-item-unknown", `${JSON.stringify(req.id)} is not a work item id`);
    if (!gitRoot(req.cwd)) throw new WorkError("not-a-git-repository", "a work lease's history is on the chant/lifecycle branch, and this directory is not in a git repository");
    const { loaded, root } = await findWorkItem(req.id, req.cwd, req.kind);
    const leaseCwd = dirname(loaded.file);
    const { prefix } = await resolveMemberLedger(leaseCwd);
    const { records: events, malformed } = await readLeaseHistory(req.id, { cwd: leaseCwd });
    const live = (await listWorkLeases({ cwd: leaseCwd, memberPrefix: prefix })).find((l) => l.item === req.id) ?? null;
    const claims = claimsOf(events, live);
    const count = (end: ClaimEnd) => claims.filter((c) => c.ended === end).length;
    const outcomes: Record<string, number> = {};
    for (const c of claims) if (c.release?.outcome) outcomes[c.release.outcome] = (outcomes[c.release.outcome] ?? 0) + 1;
    return {
      ...head,
      item: req.id,
      kind: relative(root, loaded.file).split("\\").join("/"),
      ref: workLeaseRef(req.id, prefix),
      ledger: { branch: "chant/lifecycle", path: leaseHistoryPath(req.id, prefix) },
      lease: live ? { holder: live.holder, token: live.token, acquiredAt: live.acquiredAt, expiresAt: live.expiresAt, state: live.state } : null,
      claims,
      events,
      malformed,
      summary: { claims: claims.length, released: count("released"), held: count("held"), expired: count("expired"), lost: count("lost"), outcomes },
    };
  } catch (err) {
    if (err instanceof WorkError) return { ...head, error: { code: err.code as WorkHistoryErrorCode, message: err.message } };
    throw err;
  }
}

/** The history as lines for a person. */
export function formatWorkHistory(doc: Extract<WorkHistoryDocument, { claims: unknown }>): string {
  const lines = [`${doc.item}: ${doc.ledger.branch}:${doc.ledger.path}`];
  for (const c of doc.claims) {
    const how = c.release ? `released${c.release.outcome ? ` ${c.release.outcome}` : ""} by ${c.release.by} at ${c.release.at}` : c.ended === "held" ? `held until ${c.expiresAt}` : `${c.ended}, never released (expired ${c.expiresAt})`;
    lines.push(`  ${c.acquiredAt}  ${c.holder}  token ${c.token}  ${c.renewals} renewal${c.renewals === 1 ? "" : "s"}  ${how}`);
  }
  if (doc.claims.length === 0) lines.push("  never claimed");
  if (doc.malformed > 0) lines.push(`  ${doc.malformed} malformed line${doc.malformed === 1 ? "" : "s"} left out`);
  return lines.join("\n");
}

async function runWorkHistory(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const id = args.extraPositional2;
  if (!id) {
    console.error(formatError({ message: "history needs a work item id", hint: USAGE }));
    return 1;
  }
  for (const [flag, v] of [["--holder", args.holder], ["--ttl", args.ttl], ["--token", args.token], ["--outcome", args.outcome], ["--note", args.note]] as const) {
    if (v !== undefined) {
      console.error(formatError({ message: `history is a read and takes no ${flag}`, hint: USAGE }));
      return 1;
    }
  }
  const doc = await workHistory({ id, cwd: process.cwd(), kind: args.kind });
  if (args.json) console.log(JSON.stringify(doc, null, 2));
  else if ("error" in doc) console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
  else console.log(formatWorkHistory(doc));
  return "error" in doc ? 1 : 0;
}

export async function runWorkspaceWork(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const verb = args.extraPositional;
  if (verb === "history") return runWorkHistory(ctx);
  const fail = (message: string): number => {
    if (args.json) console.log(JSON.stringify({ $schema: WORK_LEASE_OUTPUT_SCHEMA_ID, contract: WORK_LEASE_CONTRACT_VERSION, error: { code: "write-usage-invalid", message } }, null, 2));
    else console.error(formatError({ message, hint: USAGE }));
    return 1;
  };
  if (verb !== "claim" && verb !== "renew" && verb !== "release") {
    return fail(verb ? `chant workspace work takes claim, renew, release or history, not ${verb}` : "chant workspace work needs claim, renew, release or history");
  }
  const id = args.extraPositional2;
  if (!id) return fail(`${verb} needs a work item id`);
  if (!args.holder) return fail(`${verb} needs --holder <name>: who ${verb === "release" ? "gives the lease back" : "holds the lease"}`);
  if (verb === "release" && args.ttl !== undefined) return fail("release takes no --ttl");
  if (verb !== "release" && args.outcome !== undefined) return fail(`${verb} takes no --outcome; it is for release`);
  if (verb === "claim" && args.token !== undefined) return fail("claim takes no --token; a claim mints one");
  let ttlMs: number | undefined;
  if (args.ttl !== undefined) {
    try {
      ttlMs = parseTtl(args.ttl);
    } catch {
      return fail(`--ttl takes seconds or a duration such as 10m, not ${JSON.stringify(args.ttl)}`);
    }
    if (ttlMs <= 0) return fail("--ttl must be more than zero");
  }

  const doc = await workLease({ verb, id, holder: args.holder, cwd: process.cwd(), kind: args.kind, ttlMs, token: args.token, outcome: args.outcome, note: args.note });
  if (args.json) console.log(JSON.stringify(doc, null, 2));
  if ("error" in doc) {
    if (!args.json) console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
    return 1;
  }
  if ("refused" in doc) {
    if (!args.json) console.error(formatError({ message: `${doc.refused.code}: ${doc.refused.message}` }));
    return EXIT_LEASE_REFUSED;
  }
  if (!args.json) {
    const what = verb === "claim" ? "claimed" : verb === "renew" ? "renewed" : "released";
    const until = verb === "release" ? "" : ` until ${doc.lease.expiresAt}`;
    console.log(`${id} ${what} by ${args.holder}${until} (token ${doc.lease.token})`);
    console.log(`  ${doc.ref}; history ${doc.history.path}${doc.history.pushed ? "" : " (not pushed)"}`);
  }
  return 0;
}
