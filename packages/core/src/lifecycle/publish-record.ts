/**
 * The publish record (#4048): what `chant release publish` has staged and
 * revealed for a release, so a publish that failed part way resumes without
 * publishing again what already went out.
 *
 * One line per target per step in `_releases/publishes.jsonl` on
 * `chant/lifecycle`, under the member's prefix like `cuts.jsonl` beside it,
 * append-only. A target that staged gets a `staged` line with its items and
 * the state its reveal needs (a draft release's id); one that revealed gets
 * a `revealed` line. The `release.verify` commands (#5157) get a `verified`
 * or `verify-failed` line, under the target `verify:<hex>` of kind `verify`,
 * with the failing command's name and exit status in its state. The scan
 * before the stage (#5446) gets a `scanned` or `scan-failed` line, under the
 * target `scan` of kind `scan`, whose `scan` holds the scanner, its
 * database's version and every finding with what the policy made of it.
 * The lines of targets are what a resume reads. Each line is pushed as soon as it is written, so a CI
 * job that resumes on a fresh checkout reads it after `fetchLifecycle`.
 *
 * Why a record and not only the registries: a registry says whether a version
 * or a digest is there, which each target's stage asks so that it never sends
 * an item twice, but not whether a draft release, a version under `next` or
 * a pushed digest belongs to this release's publish, nor whether every
 * target of the set has staged, which is when the reveals may start. A
 * record that was not written or not pushed costs only speed: the stage runs
 * again, asks the registry, and sends nothing that is there.
 *
 * A line holds names, destinations, digests and draft ids. It never holds a
 * credential, and every line is redacted before it is written.
 */

import { sortedJsonReplacer } from "../utils";
import { appendLedgerLine, readBlobFromPath, type LedgerLocation } from "./git";
import { RELEASES_DIR } from "./release-store";
import type { PublishedTarget, PublishItem, PublishTarget, StagedTarget } from "./release-publish";
import type { Redactor } from "./publish-credentials";

/** The file the record is appended to, under `_releases/`. */
export const PUBLISHES_FILE = "publishes.jsonl";

/** One line of `_releases/publishes.jsonl`. Version 1, written by chant 0.124.29 and newer. */
export interface PublishRecord {
  version: 1;
  releaseDigest: string;
  label: string | null;
  /** The target's key ({@link PublishTarget.key}). */
  target: string;
  kind: PublishTarget["kind"] | "verify" | "scan";
  /** The target's name, for a reader. */
  name: string;
  step: "staged" | "revealed" | "verified" | "verify-failed" | "scanned" | "scan-failed";
  items: PublishItem[];
  /** On a `scanned` or `scan-failed` line (#5446): what the scan before the stage found. */
  scan?: import("./publish-scan").ScanRecord;
  /** What the reveal needs, on a `staged` line; `{}` on a `revealed` one. */
  state: Record<string, string>;
  runId: string;
  /**
   * The ssh fingerprint (`SHA256:...`) of the runner key of the `chant ci
   * serve` host that ran the publish (#5462), the key its SLSA statement
   * names as the builder. Absent for a publish no host ran.
   */
  runnerKey?: string;
  /**
   * The crypto module the publish ran on (#5470): Node, OpenSSL, whether in
   * FIPS mode, and the cosign `CHANT_COSIGN` named with its SHA-256 and
   * whether it is chant's pinned upstream build. What it reports, not a
   * claim that any of it is validated. Absent on records older than #5470.
   */
  crypto?: import("../crypto-module").CryptoRecord;
  timestamp: string;
}

/** Parse the lines of `publishes.jsonl`. A line that is not a record is counted and skipped. */
export function parsePublishRecords(text: string | null): { records: PublishRecord[]; malformed: number } {
  const records: PublishRecord[] = [];
  let malformed = 0;
  for (const line of (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Partial<PublishRecord>;
      const ok =
        r &&
        r.version === 1 &&
        typeof r.releaseDigest === "string" &&
        typeof r.target === "string" &&
        (r.step === "staged" || r.step === "revealed" || r.step === "verified" || r.step === "verify-failed" || r.step === "scanned" || r.step === "scan-failed") &&
        Array.isArray(r.items) &&
        typeof r.timestamp === "string";
      if (!ok) {
        malformed++;
        continue;
      }
      records.push({ ...(r as PublishRecord), state: r.state && typeof r.state === "object" ? r.state : {} });
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/** Every publish record of `releaseDigest`, oldest first. */
export async function readPublishRecords(releaseDigest: string, opts?: LedgerLocation): Promise<PublishRecord[]> {
  const text = await readBlobFromPath(RELEASES_DIR, PUBLISHES_FILE, opts);
  return parsePublishRecords(text).records.filter((r) => r.releaseDigest === releaseDigest);
}

/** Where each target of a release stands, by key: what it staged, and what it revealed. */
export interface PublishProgress {
  staged: Map<string, StagedTarget>;
  revealed: Map<string, PublishedTarget>;
}

/** The progress `records` show. A later line for a target replaces an earlier one of the same step. */
export function publishProgress(records: readonly PublishRecord[]): PublishProgress {
  const staged = new Map<string, StagedTarget>();
  const revealed = new Map<string, PublishedTarget>();
  for (const r of records) {
    if (r.step === "staged") staged.set(r.target, { target: r.name, destination: "", items: r.items, state: r.state });
    else if (r.step === "revealed") revealed.set(r.target, { target: r.name, destination: "", items: r.items });
  }
  return { staged, revealed };
}

/** Where `target` stands in `progress`: `revealed`, `staged`, or `none`. */
export function progressOf(progress: PublishProgress, target: Pick<PublishTarget, "key">): "revealed" | "staged" | "none" {
  if (progress.revealed.has(target.key)) return "revealed";
  if (progress.staged.has(target.key)) return "staged";
  return "none";
}

/** Append one record, redacted. Does not push. */
export async function appendPublishRecord(record: PublishRecord, redactor: Redactor, opts?: { cwd?: string }): Promise<void> {
  const line = redactor.redact(JSON.stringify(record, sortedJsonReplacer));
  await appendLedgerLine(RELEASES_DIR, PUBLISHES_FILE, line, "Release publish", opts);
}
