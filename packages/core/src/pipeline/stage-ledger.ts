/**
 * A stage's own ledger (#5355): pauses, resumes, the releases that waited
 * while the stage was paused, and each promote that passed on the urgent
 * rule.
 *
 * The lines sit in `<stage>/stage.jsonl` on `chant/lifecycle`, beside the
 * stage's `releases.jsonl`, in the member's part of the branch. Each names
 * the pipeline, so two pipelines of one member keep their own state.
 *
 * - `pause`: `chant stage pause <stage>`, or a rollback of a stage that sets
 *   `pauseAfterRollback` (`cause: "rollback"`). A paused stage refuses
 *   promotion with exit 3. A promote already applying is not stopped; it
 *   finishes and records as usual.
 * - `waiting`: a promote the pause refused, with the release it carried.
 * - `resume`: `chant stage resume <stage>`. It names the newest release that
 *   waited (`admits`) and the older ones it replaces (`superseded`). A
 *   promote of a superseded release is refused from then on, so the newest
 *   waiting release is the one that enters.
 * - `urgent`: a promote that passed the stage's gate on its urgent rule, with
 *   who approved it, who promoted it, and why.
 *
 * Every line records who wrote it (`by`) and, where one was given, why
 * (`reason`).
 */

import type { ReleaseRecord } from "../lifecycle/release-ledger";
import type { DeployOutcome } from "../lifecycle/deploy-outcome";
import { unsettledComponents } from "../lifecycle/mixed-environment";

/** The file a stage's lines are kept in, under the stage's directory on `chant/lifecycle`. */
export const STAGE_LEDGER_FILE = "stage.jsonl";

/** A release a line names: its digest and label. */
export interface StageRelease {
  digest: string;
  label: string | null;
}

/** One line of a stage's ledger. */
export interface StagePauseLine {
  version: 1;
  kind: "pause" | "resume" | "waiting" | "urgent";
  pipeline: string;
  stage: string;
  /** Who wrote it: the person who paused or resumed, or the promote's actor. */
  by: string;
  /** Why, as the person gave it. */
  reason?: string;
  timestamp: string;
  /** On a pause a rollback wrote. */
  cause?: "rollback";
  /** On `waiting` and `urgent`, the release promoted; on a pause after a rollback, the release rolled back to. */
  release?: StageRelease;
  /** On `resume`: the newest release that waited while the stage was paused. */
  admits?: StageRelease;
  /** On `resume`: the digests of the older releases that waited, which no longer enter. */
  superseded?: string[];
  /** On `urgent`: the approval the urgent rule passed on. */
  approval?: { by: string; at: string; role: string; note?: string };
}

/** Reads and appends a stage's lines. */
export interface StageLedgerPort {
  /** The stage's lines for `pipeline`, oldest first. */
  read(pipeline: string, stage: string): Promise<StagePauseLine[]>;
  append(line: StagePauseLine): Promise<{ pushed: boolean; pushWarning?: string }>;
}

/** Parse a stage ledger's text: the lines that read, and how many did not. */
export function parseStagePauseLines(text: string | null): { lines: StagePauseLine[]; malformed: number } {
  const lines: StagePauseLine[] = [];
  let malformed = 0;
  for (const raw of (text ?? "").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const v = JSON.parse(raw) as StagePauseLine;
      if (v && v.version === 1 && typeof v.pipeline === "string" && typeof v.stage === "string" && typeof v.by === "string" && typeof v.timestamp === "string" && ["pause", "resume", "waiting", "urgent"].includes(v.kind)) lines.push(v);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { lines, malformed };
}

/** A ledger held in memory, for tests and for a caller that read the lines already. */
export function memoryStageLedgerPort(seed: StagePauseLine[] = []): StageLedgerPort & { lines: StagePauseLine[] } {
  const lines = [...seed];
  return {
    lines,
    async read(pipeline, stage) {
      return lines.filter((l) => l.pipeline === pipeline && l.stage === stage);
    },
    async append(line) {
      lines.push(line);
      return { pushed: true };
    },
  };
}

/** The real port: `<stage>/stage.jsonl` on `chant/lifecycle`, appended with the ledger's retry and pushed. */
export function gitStageLedgerPort(opts?: { cwd?: string }): StageLedgerPort {
  return {
    async read(pipeline, stage) {
      const { readBlobFromPath } = await import("../lifecycle/git");
      return parseStagePauseLines(await readBlobFromPath(stage, STAGE_LEDGER_FILE, opts)).lines.filter((l) => l.pipeline === pipeline && l.stage === stage);
    },
    async append(line) {
      const { appendLedgerLine, pushLifecycleRebasing, LifecyclePushLostError } = await import("../lifecycle/git");
      const { sortedJsonReplacer } = await import("../utils");
      await appendLedgerLine(line.stage, STAGE_LEDGER_FILE, JSON.stringify(line, sortedJsonReplacer), `Stage ${line.kind}: ${line.pipeline} ${line.stage}`, opts);
      try {
        return await pushLifecycleRebasing(opts);
      } catch (err) {
        if (err instanceof LifecyclePushLostError) return { pushed: false, pushWarning: err.message };
        throw err;
      }
    },
  };
}

/** The pause standing on the stage, or undefined when it is not paused: the newest pause or resume line decides. */
export function stagePaused(lines: readonly StagePauseLine[]): StagePauseLine | undefined {
  const last = [...lines].reverse().find((l) => l.kind === "pause" || l.kind === "resume");
  return last?.kind === "pause" ? last : undefined;
}

/** The line a paused stage's refusal prints. */
export function stagePausedLine(pause: StagePauseLine): string {
  const why = pause.cause === "rollback" ? `after a rollback${pause.release ? ` to ${pause.release.label ?? pause.release.digest}` : ""}` : "";
  const parts = [why, pause.reason ? pause.reason : ""].filter(Boolean).join(": ");
  return `stage "${pause.stage}" is paused since ${pause.timestamp} by ${pause.by}${parts ? ` (${parts})` : ""}, so nothing is promoted into it`;
}

/** The releases that waited since the standing pause, oldest first, each once at its newest wait. */
export function waitingReleases(lines: readonly StagePauseLine[]): StageRelease[] {
  const pause = stagePaused(lines);
  if (!pause) return [];
  const since = lines.lastIndexOf(pause);
  const out: StageRelease[] = [];
  for (const l of lines.slice(since + 1)) {
    if (l.kind !== "waiting" || !l.release) continue;
    const at = out.findIndex((r) => r.digest === l.release!.digest);
    if (at >= 0) out.splice(at, 1);
    out.push(l.release);
  }
  return out;
}

/** The pause line for `chant stage pause`, or a refusal when the stage is paused already. */
export function pauseLine(input: { pipeline: string; stage: string; by: string; reason?: string; lines: readonly StagePauseLine[]; now: Date; cause?: "rollback"; release?: StageRelease }): StagePauseLine | { refused: string } {
  const standing = stagePaused(input.lines);
  if (standing) return { refused: `${stagePausedLine(standing)}; it is paused already` };
  return {
    version: 1,
    kind: "pause",
    pipeline: input.pipeline,
    stage: input.stage,
    by: input.by,
    ...(input.reason ? { reason: input.reason } : {}),
    timestamp: input.now.toISOString(),
    ...(input.cause ? { cause: input.cause } : {}),
    ...(input.release ? { release: input.release } : {}),
  };
}

/** The resume line for `chant stage resume`: the newest waiting release enters, the older ones are superseded. A refusal when the stage is not paused. */
export function resumeLine(input: { pipeline: string; stage: string; by: string; reason?: string; lines: readonly StagePauseLine[]; now: Date }): StagePauseLine | { refused: string } {
  if (!stagePaused(input.lines)) return { refused: `stage "${input.stage}" is not paused` };
  const waited = waitingReleases(input.lines);
  const admits = waited[waited.length - 1];
  const superseded = waited.slice(0, -1).map((r) => r.digest);
  return {
    version: 1,
    kind: "resume",
    pipeline: input.pipeline,
    stage: input.stage,
    by: input.by,
    ...(input.reason ? { reason: input.reason } : {}),
    timestamp: input.now.toISOString(),
    ...(admits ? { admits } : {}),
    ...(superseded.length > 0 ? { superseded } : {}),
  };
}

/** The line a promote the pause refused records. */
export function waitingLine(input: { pipeline: string; stage: string; by: string; release: StageRelease; now: Date }): StagePauseLine {
  return { version: 1, kind: "waiting", pipeline: input.pipeline, stage: input.stage, by: input.by, timestamp: input.now.toISOString(), release: input.release };
}

/**
 * The resume that superseded `digest`, when the stage's newest resume names
 * it among the releases that waited behind a newer one; undefined otherwise.
 */
export function supersededBy(lines: readonly StagePauseLine[], digest: string): StagePauseLine | undefined {
  const last = [...lines].reverse().find((l) => l.kind === "pause" || l.kind === "resume");
  return last?.kind === "resume" && last.superseded?.includes(digest) ? last : undefined;
}

/**
 * The components of `components` that release `releaseDigest` (cut from
 * `commit`) has not deployed in a stage, by its release ledger and deploy
 * outcomes: each needs a record of the release (or of its commit), and no
 * failed or gated run of it since. Empty when the release succeeded there.
 */
export function releaseMissingIn(input: {
  records: readonly ReleaseRecord[];
  outcomes: readonly DeployOutcome[];
  releaseDigest: string;
  commit?: string;
  components: readonly string[];
}): string[] {
  const unsettled = unsettledComponents(input.records, input.outcomes);
  return input.components.filter((component) => {
    const ran = input.records.filter((r) => r.component === component && (r.releaseDigest === input.releaseDigest || (input.commit !== undefined && r.gitSha === input.commit)));
    return ran.length === 0 || unsettled.has(component);
  });
}
