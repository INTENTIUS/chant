/**
 * What a promote, rollback or redeploy left behind when it did not deploy
 * every component it planned (#4035).
 *
 * The release ledger records a component only once its deploy succeeded, so
 * after a run that applied partly it still names the earlier release for
 * every component that failed, and nothing says that component may be
 * running part of the new one. A deploy outcome is the record of that run:
 * one line per run in `<env>/outcomes.jsonl` on `chant/lifecycle`, beside
 * the environment's `releases.jsonl` and under the same member prefix,
 * naming each planned component and what happened to it.
 *
 * It is written only when the run ended with some components deployed and
 * others not, or with a component that failed. A run that stopped at a gate
 * before deploying anything changed nothing in the environment; its pending
 * gate is what `workspace status` shows for it.
 *
 * The file is append-only, like the release ledger. Whether the environment
 * is still mixed is derived when it is read ({@link ./mixed-environment.ts}):
 * a component the outcome names as failed or gated stays unsettled until the
 * release ledger has a newer record of it, which a redeploy, a rollback or
 * the same promote run again writes.
 */

import { sortedJsonReplacer } from "../utils";
import type { PromotionPlan } from "../components/promote";
import type { DriverRunResult } from "../components/driver";

/** The file a deploy outcome is appended to, under the environment's directory. */
export const OUTCOMES_FILE = "outcomes.jsonl";

/** What a run did to one component it planned. */
export type DeployOutcomeState = "deployed" | "failed" | "gated" | "not-run";

export interface DeployOutcomeComponent {
  component: string;
  /** `deployed` (a release record was written), `failed`, `gated` (stopped at a gate after the steps before it ran), or `not-run`. */
  outcome: DeployOutcomeState;
  /** The artifact digest the run was deploying. */
  digest: string;
  /** The release the run was deploying for this component, or null when it named none. */
  releaseDigest: string | null;
}

/** One line of `<env>/outcomes.jsonl`. */
export interface DeployOutcome {
  version: 1;
  env: string;
  verb: "promote" | "rollback" | "redeploy";
  /** The run id the run's release records carry. */
  runId: string;
  /** The timestamp the run's release records carry. */
  timestamp: string;
  actor: string;
  /** The release the run deployed under (`--release`), or null. */
  releaseDigest: string | null;
  /** How the run ended. */
  status: "fail" | "gated";
  components: DeployOutcomeComponent[];
}

/**
 * The outcome to record for a run, or null when there is nothing to record:
 * every planned component deployed, or the run stopped at a gate with
 * nothing deployed and nothing failed.
 */
export function deployOutcomeOf(input: {
  verb: DeployOutcome["verb"];
  plan: PromotionPlan;
  run: Pick<DriverRunResult, "status" | "results">;
  /** The release the run deployed under, if any. */
  releaseDigest: string | null;
  runId: string;
  timestamp: string;
  actor: string;
}): DeployOutcome | null {
  const { plan, run } = input;
  if (run.status === "ok") return null;
  const components: DeployOutcomeComponent[] = plan.items.map((item) => {
    const result = run.results.find((r) => r.component === item.component);
    const outcome: DeployOutcomeState = !result ? "not-run" : result.status === "ok" ? "deployed" : result.status === "gated" ? "gated" : "failed";
    return {
      component: item.component,
      outcome,
      digest: item.digest,
      releaseDigest: input.releaseDigest ?? item.source.releaseDigest ?? null,
    };
  });
  const deployed = components.some((c) => c.outcome === "deployed");
  const failed = components.some((c) => c.outcome === "failed");
  if (!deployed && !failed) return null;
  return {
    version: 1,
    env: plan.to,
    verb: input.verb,
    runId: input.runId,
    timestamp: input.timestamp,
    actor: input.actor,
    releaseDigest: input.releaseDigest,
    status: run.status,
    components,
  };
}

const STATES: readonly string[] = ["deployed", "failed", "gated", "not-run"];

function isOutcome(v: unknown): v is DeployOutcome {
  const o = v as Partial<DeployOutcome> | null;
  return (
    o !== null &&
    typeof o === "object" &&
    o.version === 1 &&
    typeof o.env === "string" &&
    typeof o.runId === "string" &&
    typeof o.timestamp === "string" &&
    Array.isArray(o.components) &&
    o.components.every((c) => c && typeof c.component === "string" && STATES.includes(c.outcome) && typeof c.digest === "string")
  );
}

/** Parse the lines of an `outcomes.jsonl`, oldest first. A line that is not an outcome is counted and skipped. */
export function parseDeployOutcomes(text: string | null): { outcomes: DeployOutcome[]; malformed: number } {
  const outcomes: DeployOutcome[] = [];
  let malformed = 0;
  for (const line of (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isOutcome(parsed)) outcomes.push(parsed);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { outcomes, malformed };
}

/** Append one outcome to `<env>/outcomes.jsonl`. Does not push; the caller pushes with the release records. */
export async function appendDeployOutcome(outcome: DeployOutcome, opts?: { cwd?: string }): Promise<string> {
  const { appendLedgerLine } = await import("./git");
  return appendLedgerLine(outcome.env, OUTCOMES_FILE, JSON.stringify(outcome, sortedJsonReplacer), "Deploy outcome", opts);
}

/** Every outcome recorded for `env`, oldest first, read where `readReleaseLedger` reads; `[]` when none is. */
export async function readDeployOutcomes(env: string, opts?: import("./git").LedgerLocation): Promise<DeployOutcome[]> {
  const { readBlobFromPath } = await import("./git");
  return parseDeployOutcomes(await readBlobFromPath(env, OUTCOMES_FILE, opts)).outcomes;
}
