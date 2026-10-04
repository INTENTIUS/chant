/**
 * `chant workspace lock` (#3173, ws-089): the working tree's write lock
 * (`write-lock.ts`), seen and held from outside chant.
 *
 * - `lock` prints who holds it now, or that nobody does.
 * - `lock acquire --holder <name> [--ttl <duration>]` takes it for a batch of
 *   writes across several chant calls, waiting for it as a write does, and
 *   prints the token. Each chant write of the batch runs with
 *   `CHANT_WRITE_LOCK=<token>` and goes ahead without waiting; every other
 *   writer waits. The lock lasts until it is released or the ttl passes
 *   (default 60s, at most 10m), after which any writer may break it.
 * - `lock release --token <token>` gives it back.
 *
 * Each prints one JSON document (`write-lock.schema.json`); a refusal exits 1.
 * The token is printed only to the caller that took the lock: `lock` never
 * prints it, so holding the lock can't be taken over by reading who holds it.
 */

import type { CommandContext } from "../cli/registry";
import { parseDuration } from "../op/duration";
import { readerVersion } from "./declaration";
import {
  acquireBatchLock,
  DEFAULT_BATCH_TTL_MS,
  MAX_BATCH_TTL_MS,
  releaseLock,
  writeLockHolder,
  writeLockPath,
  WriteLockError,
  type WriteLockHolder,
} from "./write-lock";
import { AGENT_ENV } from "./write-scope";

export const WRITE_LOCK_CONTRACT_VERSION = 1;
export const WRITE_LOCK_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/write-lock/v1/write-lock.schema.json";

/** Why a lock command did nothing. Closed. */
export const WRITE_LOCK_ERROR_CODES = ["write-usage-invalid", "write-lock-timeout", "write-lock-not-held"] as const;
export type WriteLockErrorCode = (typeof WRITE_LOCK_ERROR_CODES)[number];

/** A holder as the documents show it: everything but the token. */
export type HolderView = Omit<WriteLockHolder, "token">;

export type WriteLockDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      verb: "status" | "acquire" | "release";
      /** The lock directory. */
      path: string;
      /** Who holds the lock after the command: the batch for acquire, null after release. */
      holder: HolderView | null;
      /** acquire only: the token each write of the batch runs with, as CHANT_WRITE_LOCK. */
      token?: string;
    }
  | { $schema: string; contract: number; chant: string; verb: "status" | "acquire" | "release"; error: { code: WriteLockErrorCode; message: string }; holder: HolderView | null };

const USAGE = "chant workspace lock [acquire --holder <name> [--ttl <duration>] | release --token <token>] [--json]";

function view(h: WriteLockHolder | null): HolderView | null {
  if (h === null) return null;
  const { token: _token, ...rest } = h;
  return rest;
}

/** Run one lock command and build its document. */
export async function workspaceLock(req: { cwd: string; verb: string | undefined; holder?: string; ttl?: string; token?: string; agent?: string }): Promise<WriteLockDocument> {
  const verb = req.verb === undefined || req.verb === "status" ? "status" : req.verb === "acquire" || req.verb === "release" ? req.verb : null;
  const head = { $schema: WRITE_LOCK_SCHEMA_ID, contract: WRITE_LOCK_CONTRACT_VERSION, chant: readerVersion() };
  const fail = (v: "status" | "acquire" | "release", code: WriteLockErrorCode, message: string, holder: WriteLockHolder | null = null): WriteLockDocument => ({
    ...head,
    verb: v,
    error: { code, message: code === "write-usage-invalid" ? `${message}\n${USAGE}` : message },
    holder: view(holder),
  });
  if (verb === null) return fail("status", "write-usage-invalid", `lock takes acquire or release, or nothing to say who holds it, not ${req.verb}`);
  if (verb === "status") {
    if (req.holder !== undefined || req.ttl !== undefined || req.token !== undefined) return fail(verb, "write-usage-invalid", "lock with no verb only says who holds the lock, and takes no --holder, --ttl or --token");
    const { path, holder } = writeLockHolder(req.cwd);
    return { ...head, verb, path, holder: view(holder) };
  }
  if (verb === "acquire") {
    if (!req.holder) return fail(verb, "write-usage-invalid", "lock acquire needs --holder <name>: who holds the lock, as the other writers waiting on it are told");
    if (req.token !== undefined) return fail(verb, "write-usage-invalid", "lock acquire hands out a token, and takes none");
    let ttlMs = DEFAULT_BATCH_TTL_MS;
    if (req.ttl !== undefined) {
      const ms = /^\d+$/.test(req.ttl) ? Number(req.ttl) * 1000 : parseDurationOrNull(req.ttl);
      if (ms === null || ms <= 0 || ms > MAX_BATCH_TTL_MS) return fail(verb, "write-usage-invalid", `--ttl takes a duration up to ${MAX_BATCH_TTL_MS / 60_000}m, such as 90s or 5m, not ${JSON.stringify(req.ttl)}`);
      ttlMs = ms;
    }
    try {
      const { path, holder } = await acquireBatchLock(req.cwd, { verb: "batch", by: req.holder, agent: req.agent ?? null }, ttlMs);
      return { ...head, verb, path, holder: view(holder), token: holder.token };
    } catch (err) {
      if (err instanceof WriteLockError) return fail(verb, err.code, err.message, err.holder);
      throw err;
    }
  }
  if (!req.token) return fail(verb, "write-usage-invalid", "lock release needs --token <token>, as lock acquire printed it");
  if (req.holder !== undefined || req.ttl !== undefined) return fail(verb, "write-usage-invalid", "lock release takes only --token");
  const path = writeLockPath(req.cwd);
  if (!releaseLock(path, req.token)) {
    const { holder } = writeLockHolder(req.cwd);
    return fail(verb, "write-lock-not-held", `the token given does not hold the write lock (${holder ? "another writer holds it" : "nobody holds it"}): it was released already, or it expired`, holder);
  }
  return { ...head, verb, path, holder: null };
}

function parseDurationOrNull(raw: string): number | null {
  try {
    return parseDuration(raw);
  } catch {
    return null;
  }
}

/** `chant workspace lock [acquire|release]`. Prints one JSON document; exits 1 on a refusal. */
export async function runWorkspaceLock(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const doc = await workspaceLock({
    cwd: process.cwd(),
    verb: args.extraPositional,
    holder: args.holder,
    ttl: args.ttl,
    token: args.token,
    agent: process.env[AGENT_ENV] || undefined,
  });
  console.log(JSON.stringify(doc, null, 2));
  return "error" in doc ? 1 : 0;
}
