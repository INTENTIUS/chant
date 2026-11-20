/**
 * A pipeline's stage log (#5353): which release is in each stage, which
 * waits for it, which one a newer release replaced, and how each ended.
 *
 * The lines sit in `_gates/<pipeline>/stages.jsonl` on `chant/lifecycle`,
 * beside the pipeline's gate ledger, under the member's ledger prefix. A
 * promote into a stage of a pipeline that declares `after` or `queue` on
 * any stage writes them; any other pipeline writes none.
 *
 * - `waiting`: a release reached a stage with `queue: "replace"` and waits
 *   for its gate, or for the release in the stage to finish.
 * - `replaced`: a waiting release was replaced by a newer one (`by`). It is
 *   never let into that stage afterwards.
 * - `entered`: a release passed the stage's gate and its deploy started.
 * - `finished`: that deploy ended, `applied` or `failed`.
 *
 * A stage's release has succeeded there once a `finished` line with result
 * `applied` names it; a stage with several upstream stages reads that for
 * each of them. The reading half is pure; the git half is the port.
 */

import { readBlobBySha, readBlobFromPath, readPathSha, requireLifecycleLedger, writeBlobToPath, pushLifecycleRebasing, LifecyclePushLostError, RefCASConflictError } from "./git";
import { sortedJsonReplacer } from "../utils";

/** One line of `stages.jsonl`. */
export interface StageLine {
  version: 1;
  kind: "waiting" | "replaced" | "entered" | "finished";
  /** The pipeline's name, the op its stage gates are recorded under. */
  op: string;
  /** The stage, which is its environment's name. */
  stage: string;
  /** The digest the stage gate binds: the release's, or the promoted digests'. */
  digest: string;
  timestamp: string;
  /** The release's label, when it has one. */
  label?: string;
  /** When the release was cut, which orders two releases waiting for one stage. */
  cutAt?: string;
  /** On `replaced`: the digest of the release that replaced it. */
  by?: string;
  /** On `replaced`: that release's label, when it has one. */
  byLabel?: string;
  /** On `finished`: how the deploy ended. */
  result?: "applied" | "failed";
  actor?: string;
  runId?: string;
}

/** Where a pipeline's stage log lives, as `writeBlobToPath` takes it. */
export function stageLogPath(op: string): { dir: string; file: string } {
  return { dir: `_gates/${op}`, file: "stages.jsonl" };
}

/** The lines of a `stages.jsonl` file, oldest first. A line that is not one is skipped. */
export function parseStageLines(text: string): StageLine[] {
  const out: StageLine[] = [];
  for (const raw of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r?.version !== 1 || !["waiting", "replaced", "entered", "finished"].includes(r.kind as string)) continue;
    if (typeof r.op !== "string" || typeof r.stage !== "string" || typeof r.digest !== "string" || typeof r.timestamp !== "string") continue;
    if (r.kind === "finished" && r.result !== "applied" && r.result !== "failed") continue;
    if (r.kind === "replaced" && typeof r.by !== "string") continue;
    out.push(r as unknown as StageLine);
  }
  return out;
}

/** One stage as its log reads: the release in it, the one waiting, and the ones replaced. */
export interface StageQueue {
  stage: string;
  /** The `entered` line of the release whose deploy has not finished, or null. */
  inStage: StageLine | null;
  /** The `waiting` lines of releases neither replaced, entered nor finished since, oldest first. */
  waiting: StageLine[];
  /** Every `replaced` line, oldest first. */
  replaced: StageLine[];
}

const at = (iso: string): number => Date.parse(iso);

/** Stage `stage` as `lines` record it. */
export function stageQueueOf(lines: readonly StageLine[], stage: string): StageQueue {
  const own = lines.filter((l) => l.stage === stage);
  let inStage: StageLine | null = null;
  const waiting = new Map<string, StageLine>();
  const replaced: StageLine[] = [];
  for (const line of own) {
    if (line.kind === "waiting") {
      if (!waiting.has(line.digest)) waiting.set(line.digest, line);
    } else if (line.kind === "replaced") {
      waiting.delete(line.digest);
      replaced.push(line);
    } else if (line.kind === "entered") {
      waiting.delete(line.digest);
      inStage = line;
    } else {
      waiting.delete(line.digest);
      if (inStage?.digest === line.digest) inStage = null;
    }
  }
  return { stage, inStage, waiting: [...waiting.values()].sort((a, b) => at(a.timestamp) - at(b.timestamp)), replaced };
}

/** The `replaced` line that keeps `digest` out of `stage`, or undefined. */
export function replacedIn(lines: readonly StageLine[], stage: string, digest: string): StageLine | undefined {
  return lines.find((l) => l.kind === "replaced" && l.stage === stage && l.digest === digest);
}

/** Whether the release `digest` was applied in `stage`: a `finished` line with result `applied` names it. */
export function succeededIn(lines: readonly StageLine[], stage: string, digest: string): boolean {
  return lines.some((l) => l.kind === "finished" && l.result === "applied" && l.stage === stage && l.digest === digest);
}

/** Every stage the log names, in the order first met. */
export function stagesInLog(lines: readonly StageLine[]): string[] {
  return [...new Set(lines.map((l) => l.stage))];
}

/** Reads and appends a pipeline's stage log. */
export interface StageLogPort {
  read(op: string): Promise<StageLine[]>;
  append(line: StageLine): Promise<{ pushed: boolean; pushWarning?: string }>;
}

/** The log held in memory, for tests and for a caller that read it already. */
export function memoryStageLogPort(seed: StageLine[] = []): StageLogPort & { lines: StageLine[] } {
  const lines = [...seed];
  return {
    lines,
    async read(op) {
      return lines.filter((l) => l.op === op);
    },
    async append(line) {
      lines.push(line);
      return { pushed: true };
    },
  };
}

/** The log on `chant/lifecycle`: each append lands on top of the remote's ledger, retrying a concurrent writer, then pushes. */
export function gitStageLogPort(opts?: { cwd?: string }): StageLogPort {
  return {
    async read(op) {
      await requireLifecycleLedger(opts);
      const { dir, file } = stageLogPath(op);
      const text = await readBlobFromPath(dir, file, opts);
      return text ? parseStageLines(text) : [];
    },
    async append(line) {
      const { dir, file } = stageLogPath(line.op);
      const json = JSON.stringify(line, sortedJsonReplacer);
      await requireLifecycleLedger(opts);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const prior = await readPathSha(dir, file, opts);
          const existing = prior ? await readBlobBySha(prior, opts) : null;
          await writeBlobToPath(dir, file, existing ? `${existing.replace(/\n$/, "")}\n${json}\n` : `${json}\n`, `Stage ${line.stage} of ${line.op}: ${line.kind} ${line.digest}`, { ...opts, expectPriorPathSha: prior });
          try {
            return await pushLifecycleRebasing(opts);
          } catch (err) {
            if (err instanceof LifecyclePushLostError) return { pushed: false, pushWarning: `LifecyclePushLostError: ${err.message}` };
            throw err;
          }
        } catch (err) {
          if (!(err instanceof RefCASConflictError)) throw err;
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
}
