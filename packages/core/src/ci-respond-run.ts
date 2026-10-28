/**
 * Where the responses of #4629 hook in: a `pr-apply` report, an op wave
 * job's outcome, and the plan-note job's report. Each reads what the run
 * already has (the report, the run's result, the change sets stored on
 * `chant/lifecycle`) and posts through `./ci-respond.ts`. Nothing here
 * throws or changes an exit code.
 */

import type { ChangeSetDocument } from "./change-set";
import { activeProductWords, notifyWaveLabel, type CiProductWords } from "./ci-product-words";
import { CHANT_EXIT } from "./exit-codes";
import type { PrForge } from "./pr-forge";
import type { PrReport } from "./pr-loop";
import type { OpWavesSpec } from "./op/op-waves";
import type { RunOpWaveResult } from "./op/op-waves-run";
import type { OpWaveOutcome } from "./op/op-waves-notify";
import {
  changeSetDiff,
  checkDescription,
  DESCRIPTION_QUESTION,
  digestDiff,
  postResponse,
  renderRefusedDiff,
  renderTriage,
  resolveResponses,
  respondMarker,
  type CiResponses,
  type DescriptionAsk,
  type DescriptionFinding,
  type FailedApply,
  type RefusedDiff,
  type RespondPlace,
  type RespondPost,
} from "./ci-respond";

/** Reads a change set stored under its digest; undefined when none is stored or it cannot be read. */
export type ChangeSetReader = (digest: string) => Promise<ChangeSetDocument | undefined>;

/** The ledger's reader: `chant/lifecycle`'s `_change-sets`, loaded on first call. */
export const ledgerChangeSetReader: ChangeSetReader = async (digest) => {
  try {
    const { readStoredChangeSet } = await import("./lifecycle/change-set-store");
    const read = await readStoredChangeSet(digest);
    return read.status === "found" ? read.document : undefined;
  } catch {
    return undefined;
  }
};

const log = (line: string): void => {
  process.stderr.write(line + "\n");
};

// ---------------------------------------------------------------------------
// pr-apply
// ---------------------------------------------------------------------------

/** How a `pr-apply` post names the change. */
function applyLabel(report: Pick<PrReport, "pr" | "member" | "op">, words: CiProductWords): string {
  const what = report.pr !== null ? `the ${words.verbs.apply[0]} of pull request ${report.pr}` : `the ${words.verbs.apply[0]} of ${report.op}`;
  return report.member ? `${what} (${report.member})` : what;
}

/** A failed `pr-apply` report as a triage, or undefined when it did not fail. */
export function triageOfPrReport(report: PrReport, words: CiProductWords = activeProductWords()): FailedApply | undefined {
  if (report.stage !== "apply" || report.status !== "failed") return undefined;
  const members = report.members.filter((m) => m.status === "failed").map((m) => ({ member: m.member, ...(m.error ? { error: m.error } : {}) }));
  return {
    label: applyLabel(report, words),
    exitCode: 1,
    members,
    ...(members.length === 0 && report.message ? { error: report.message } : {}),
  };
}

/** A refused `pr-apply` report as a refused diff, or undefined when it was not refused for a moved plan or a holder. */
export async function refusedOfPrReport(report: PrReport, read: ChangeSetReader = ledgerChangeSetReader, words: CiProductWords = activeProductWords()): Promise<RefusedDiff | undefined> {
  if (report.stage !== "apply" || report.status !== "refused") return undefined;
  const label = applyLabel(report, words);
  if (report.refusal === "plan-changed" || report.refusal === "wave-plan-changed") {
    const approvedDigest = report.approval.approved ?? null;
    const approved = approvedDigest ? await read(approvedDigest) : undefined;
    return { label, reason: "moved", approved: approvedDigest, current: report.digest, members: changeSetDiff(approved, report.changeSet) };
  }
  if (report.refusal === "locked") return { label, reason: "held", approved: report.digest, current: report.digest, members: [], ...(report.message ? { detail: firstLine(report.message) } : {}) };
  return undefined;
}

/** The responses a `pr-apply` report calls for, posted on its pull request. */
export async function respondPrApply(
  forge: Pick<PrForge, "upsertComment" | "trackIssue"> | undefined,
  report: PrReport,
  given?: CiResponses,
  opts: { read?: ChangeSetReader; env?: Record<string, string | undefined>; words?: CiProductWords } = {},
): Promise<RespondPost[]> {
  if (!forge || report.pr === null) return [];
  const responses = resolveResponses(given, opts.env, log);
  const words = opts.words ?? activeProductWords();
  const place = `${report.op}:${report.env}${report.member ? `:${report.member}` : ""}`;
  const posts: RespondPost[] = [];
  try {
    if (responses["apply-failed"] === "triage") {
      const triage = triageOfPrReport(report, words);
      if (triage) posts.push(await postResponse(forge, "apply-failed", place, { pr: report.pr }, renderTriage(triage, words)));
    }
    if (responses["wave-refused"] === "diff") {
      const refused = await refusedOfPrReport(report, opts.read, words);
      if (refused) posts.push(await postResponse(forge, "wave-refused", place, { pr: report.pr }, renderRefusedDiff(refused, words)));
    }
  } catch (err) {
    posts.push({ posted: false, warning: `the responses were not posted: ${err instanceof Error ? err.message : String(err)}` });
  }
  for (const p of posts) if (p.warning) log(p.warning);
  return posts;
}

// ---------------------------------------------------------------------------
// op waves
// ---------------------------------------------------------------------------

/** What a failed op wave job's run record says failed, or undefined when it did not fail. */
export function triageOfOpWave(spec: OpWavesSpec, k: number, outcome: OpWaveOutcome, words: CiProductWords = activeProductWords()): FailedApply | undefined {
  const name = spec.waves[k - 1]?.name;
  const label = notifyWaveLabel(words, { k, ...(name ? { name } : {}), spec: spec.name });
  if (outcome.error !== undefined) return { label, exitCode: CHANT_EXIT.failed, members: [], error: outcome.error };
  const result = outcome.result;
  if (result.exitCode !== CHANT_EXIT.failed) return undefined;
  const members = result.failed.map((target) => {
    const t = result.targets?.[target];
    return { member: target, ...(t?.error ? { error: t.error } : {}), ...(t?.failedResources?.length ? { resources: [...t.failedResources] } : {}) };
  });
  const hooks = result.hooks.filter((h) => h.outcome === "failed").map((h) => `${h.moment} hook ${h.name}${h.target ? ` (${h.target})` : ""} failed`);
  return { label, exitCode: result.exitCode, members, ...(members.length === 0 && hooks.length > 0 ? { error: hooks.join("\n") } : {}) };
}

/** A refused op wave job (moved, held or declined) as a refused diff, or undefined when it was not refused. */
export async function refusedOfOpWave(spec: OpWavesSpec, k: number, result: RunOpWaveResult, read: ChangeSetReader = ledgerChangeSetReader, words: CiProductWords = activeProductWords()): Promise<RefusedDiff | undefined> {
  const name = spec.waves[k - 1]?.name;
  const label = notifyWaveLabel(words, { k, ...(name ? { name } : {}), spec: spec.name });
  const d = result.decision;
  if (result.exitCode === CHANT_EXIT.moved) {
    // The share job refused the runs whose plan moved since the decision: the decision's digests against the plans the job read.
    const approved: Record<string, string | null> = Object.fromEntries((d?.members ?? []).filter((m) => result.moved.includes(m.member)).map((m) => [m.member, m.planDigest ?? null]));
    const current = Object.fromEntries(result.moved.map((t) => [t, result.plans?.[t]?.planDigest ?? null]));
    for (const t of result.moved) if (!(t in approved)) approved[t] = null;
    return { label, reason: "moved", approved: d?.digest ?? null, current: null, members: digestDiff(approved, current) };
  }
  if (result.exitCode === CHANT_EXIT.waiting && d?.via === undefined && d?.coveredBy?.digest && d.coveredBy.digest !== d.digest) {
    // Under `pull-request` approvals a wave whose plan the approved change set no longer covers waits at its own gate.
    const [approved, current] = await Promise.all([read(d.coveredBy.digest), read(d.digest)]);
    return { label, reason: "moved", approved: d.coveredBy.digest, current: d.digest, members: changeSetDiff(approved, current, d.members.map((m) => m.member)) };
  }
  if (result.exitCode === CHANT_EXIT.held && result.outcome?.outcome === "held") {
    const holder = result.outcome.holder;
    return { label, reason: "held", approved: d?.digest ?? null, current: d?.digest ?? null, members: [], ...(holder ? { detail: `held by ${holder.run}` } : result.outcome.reason ? { detail: result.outcome.reason } : {}) };
  }
  if (result.exitCode === CHANT_EXIT.declined && d?.refused?.reason === "point") {
    const answer = d.point?.answer?.answer;
    return { label, reason: "declined", approved: d.digest, current: d.digest, members: [], detail: `${d.point?.name ?? "the point"} answered ${JSON.stringify(answer ?? null)}` };
  }
  return undefined;
}

/** The forge and place an op wave job posts on: its pull request when it has one, else a tracking issue. */
export async function opWavePlace(forge: Pick<PrForge, "pullRequestFor">, result: RunOpWaveResult | undefined, head: string | undefined): Promise<RespondPlace | undefined> {
  const pr = result?.decision?.review?.pr ?? pullRequestOfOpName(result?.decision?.op);
  if (pr !== undefined) return { pr };
  if (head) {
    try {
      const found = await forge.pullRequestFor(head);
      if (found !== null) return { pr: found };
    } catch {
      /* fall through to the issue */
    }
  }
  return undefined;
}

/** `pr-12` and `pr-12-<member>` name pull request 12. */
function pullRequestOfOpName(op: string | undefined): number | undefined {
  const m = op ? /^pr-(\d+)(?:-|$)/.exec(op) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * The responses an op wave job's outcome calls for (#4629): the spec's
 * `respond`, over `CHANT_RESPOND`. Posted on the pull request the wave
 * applies (its review, its `pr-<n>` op, or the one that merged `head`),
 * else on a tracking issue per spec and wave.
 */
export async function respondOpWave(
  spec: OpWavesSpec,
  k: number,
  outcome: OpWaveOutcome,
  opts: { forge?: Pick<PrForge, "upsertComment" | "trackIssue" | "pullRequestFor">; head?: string; read?: ChangeSetReader; env?: Record<string, string | undefined>; words?: CiProductWords } = {},
): Promise<RespondPost[]> {
  const forge = opts.forge;
  if (!forge) return [];
  const responses = resolveResponses(spec.respond, opts.env, log);
  const words = opts.words ?? activeProductWords();
  const posts: RespondPost[] = [];
  try {
    const triage = responses["apply-failed"] === "triage" ? triageOfOpWave(spec, k, outcome, words) : undefined;
    const refused = responses["wave-refused"] === "diff" && outcome.result ? await refusedOfOpWave(spec, k, outcome.result, opts.read, words) : undefined;
    if (!triage && !refused) return [];
    const place = `${spec.name}:wave-${k}`;
    const where = (await opWavePlace(forge, outcome.result, opts.head)) ?? { issue: `${words.product}: ${spec.name} wave ${k}` };
    if (triage) posts.push(await postResponse(forge, "apply-failed", place, where, renderTriage(triage, words)));
    if (refused) posts.push(await postResponse(forge, "wave-refused", place, where, renderRefusedDiff(refused, words)));
  } catch (err) {
    posts.push({ posted: false, warning: `the responses were not posted: ${err instanceof Error ? err.message : String(err)}` });
  }
  for (const p of posts) if (p.warning) log(p.warning);
  return posts;
}

// ---------------------------------------------------------------------------
// plan note: description check
// ---------------------------------------------------------------------------

/** The description check's settings: the decide backend and model, and the threshold. */
export interface DescriptionCheckSettings {
  ask: DescriptionAsk;
  threshold?: number;
}

/**
 * The description check on a plan report's change set (#4629), from the
 * plan-note job: the pull request's title and body read from the forge,
 * the finding posted as its own comment. A clear answer edits an earlier
 * finding away. Never throws.
 */
export async function respondDescription(
  forge: Pick<PrForge, "upsertComment" | "findComment" | "trackIssue" | "pullRequestHead" | "findPullRequest">,
  report: Pick<PrReport, "pr" | "env" | "member" | "changeSet" | "status">,
  settings: DescriptionCheckSettings,
  words: CiProductWords = activeProductWords(),
): Promise<DescriptionFinding | undefined> {
  if (report.pr === null || report.status === "nothing") return undefined;
  try {
    const head = await forge.pullRequestHead?.(report.pr);
    const pull = head ? await forge.findPullRequest(head.branch) : undefined;
    if (!pull) {
      log(`description check: could not read pull request ${report.pr}'s title and description`);
      return undefined;
    }
    const finding = await checkDescription({ doc: report.changeSet, title: pull.title, description: pull.body ?? "", ask: settings.ask, ...(settings.threshold !== undefined ? { threshold: settings.threshold } : {}), words });
    const place = `${report.env}${report.member ? `:${report.member}` : ""}`;
    if (finding.status === "flagged" && finding.body) {
      const posted = await postResponse(forge, "description", place, { pr: report.pr }, finding.body);
      if (posted.warning) log(posted.warning);
    } else if (finding.status === "clear") {
      // An earlier finding on this pull request no longer holds: say so in its place.
      if (await forge.findComment(report.pr, respondMarker("description", place))) {
        await postResponse(forge, "description", place, { pr: report.pr }, `The description now covers what the ${words.verbs.plan[0]} destroys and replaces.`);
      }
    } else if (finding.status === "error") {
      log(`description check: the decide service did not answer: ${finding.reason}`);
    }
    return finding;
  } catch (err) {
    log(`description check: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * A {@link DescriptionAsk} over a `decide.backends` entry: the Noul
 * question posted to the backend's `/v1/systemone`. The backend's module
 * loads on first call.
 */
export function backendDescriptionAsk(backend: import("./op/decide-config").DecideBackend, opts: { name: string; model: string; cwd: string; env?: NodeJS.ProcessEnv; transport?: typeof fetch }): DescriptionAsk {
  return async (state) => {
    const { postQuestion } = await import("./op/decide-backend");
    const { model, answer } = await postQuestion(
      backend,
      opts.name,
      { point: "description", backend: opts.name, model: opts.model, question: { type: "noul", instructions: DESCRIPTION_INSTRUCTIONS, criteria: { ...DESCRIPTION_CRITERIA } }, state: state as unknown as Record<string, unknown> },
      { cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}), ...(opts.transport ? { transport: opts.transport } : {}) },
    );
    if (answer.type !== "noul" || typeof answer.noul !== "number") throw new Error(`${opts.name} answered the description question with a ${answer.type} answer, not a noul`);
    return { model, probability: answer.noul, ...(answer.reason ? { reason: answer.reason } : {}) };
  };
}

const DESCRIPTION_INSTRUCTIONS: string = DESCRIPTION_QUESTION.instructions;
const DESCRIPTION_CRITERIA: Record<string, string> = DESCRIPTION_QUESTION.criteria;

function firstLine(text: string): string {
  return text.split("\n")[0]!.trim();
}
