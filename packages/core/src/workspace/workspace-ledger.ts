/**
 * The workspace's own ledger (#2554, #2524 D17, ws-030): `_members/_workspace/`
 * on the `chant/lifecycle` branch, beside every member's `_members/<member>/`.
 * `_workspace` is a reserved member name, so no member writes here.
 *
 * Three stores, each a JSON Lines file appended with the read-modify-write
 * and CAS retry every ledger here uses:
 *
 * - `<env>/runs.jsonl`: one record per `chant workspace run`, naming every
 *   `<member>/<op>` step, how it ended, and the member run it started. Each
 *   member run cites the workspace run back (`OpRunRecord.workspaceRun`).
 * - `_gates/<gate>.jsonl`: a workspace gate's pending facts and approvals.
 *   Each names the member plans it covers and their digest
 *   (`./workspace-gates.ts`).
 * - `<env>/trains.jsonl`: release trains, each pinning one release of every
 *   `chant` member (`./release-train.ts`).
 *
 * A malformed line is skipped and counted, never thrown on.
 */

import { createHash } from "node:crypto";
import { readBlobBySha, readBlobFromPath, readPathSha, RefCASConflictError, writeBlobToPath, type LedgerLocation } from "../lifecycle/git";
import { MEMBERS_DIR } from "../lifecycle/member-ledger";
import { sortedJsonReplacer } from "../utils";

/** The reserved member name the workspace's own ledger sits under. */
export const WORKSPACE_LEDGER_NAME = "_workspace";
/** The branch prefix of the workspace's ledger. */
export const WORKSPACE_LEDGER_PREFIX = `${MEMBERS_DIR}/${WORKSPACE_LEDGER_NAME}/`;
/** The environment directory a run with no `--env` records under, as a member Op run does. */
export const DEFAULT_WORKSPACE_ENV = "local";
export const WORKSPACE_GATES_DIR = "_gates";

const APPEND_RETRY_ATTEMPTS = 5;

function at(cwd: string): LedgerLocation {
  return { cwd, ledgerPrefix: WORKSPACE_LEDGER_PREFIX };
}

/** Append one line to `<dir>/<file>` in the workspace ledger. Returns the ledger commit. */
export async function appendWorkspaceLine(cwd: string, dir: string, file: string, value: unknown, message: string): Promise<string> {
  const json = JSON.stringify(value, sortedJsonReplacer);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(dir, file, at(cwd));
      const existing = priorSha ? await readBlobBySha(priorSha, { cwd }) : null;
      const content = `${existing ? `${existing.replace(/\n$/, "")}\n` : ""}${json}\n`;
      return await writeBlobToPath(dir, file, content, message, { ...at(cwd), expectPriorPathSha: priorSha });
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Read every line of `<dir>/<file>` that `accept` takes, oldest first. */
export async function readWorkspaceLines<T>(cwd: string, dir: string, file: string, accept: (v: unknown) => v is T): Promise<{ records: T[]; malformed: number }> {
  const content = await readBlobFromPath(dir, file, at(cwd));
  if (!content) return { records: [], malformed: 0 };
  const records: T[] = [];
  let malformed = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (accept(v)) records.push(v);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/** `sha256:<hex>` over a value's canonical JSON (keys sorted). */
export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value, sortedJsonReplacer)).digest("hex")}`;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/** How one `<member>/<op>` step of a workspace run ended. */
export type WorkspaceStepStatus = "ok" | "fail" | "gated" | "not-run";

export interface WorkspaceRunStep {
  /** `<member>/<op>`. */
  target: string;
  member: string;
  op: string;
  status: WorkspaceStepStatus;
  /** The member's `chant run` exit code; null for a step that did not run. */
  exitCode: number | null;
  /** The member run's id, read back from the member's run ledger, where it cites this run. Null when none was found. */
  memberRun: string | null;
  /** For a gated step: the member gate it stopped at and the plan it waits on. */
  gate?: { op: string; name: string; planDigest: string | null; environment: string | null };
}

export interface WorkspaceRunRecord {
  version: 1;
  id: string;
  started: string;
  ended: string;
  /** `gated` when a step stopped at a gate; `fail` when a step failed. A run stops at the first step that does not pass. */
  status: "ok" | "fail" | "gated";
  /** `--env`, or null. */
  env: string | null;
  /** The workspace gate the run was started under (`--gate`), or null. */
  gate: string | null;
  /** `--dependents-of`, the member whose dependents the run ran, or null. */
  dependentsOf: string | null;
  steps: WorkspaceRunStep[];
}

const RUNS_FILE = "runs.jsonl";

function isRunRecord(v: unknown): v is WorkspaceRunRecord {
  const r = v as WorkspaceRunRecord;
  return typeof r === "object" && r !== null && r.version === 1 && typeof r.id === "string" && Array.isArray(r.steps);
}

export async function appendWorkspaceRun(cwd: string, record: WorkspaceRunRecord): Promise<string> {
  return appendWorkspaceLine(cwd, record.env ?? DEFAULT_WORKSPACE_ENV, RUNS_FILE, record, `Workspace run record: ${record.id}`);
}

export async function readWorkspaceRuns(cwd: string, env: string = DEFAULT_WORKSPACE_ENV): Promise<{ records: WorkspaceRunRecord[]; malformed: number }> {
  return readWorkspaceLines(cwd, env, RUNS_FILE, isRunRecord);
}
