/**
 * Running a pull request's environment (#4330): `up`, `down` and `sweep` as
 * functions over an adapter, so a product that plans and applies with a tool
 * chant does not run (terragucci, with Terraform roots under suffixed state
 * keys) keeps its own plan, apply and teardown and takes the rest from chant:
 *
 * - the gate: a non-empty plan applies only once a person's approval of its
 *   digest stands under gate `pr-env` (ws-080, ws-104), and an empty one
 *   applies at once;
 * - the records on chant/lifecycle (`_pr-envs/records.jsonl`), the TTL and
 *   which environments stand ({@link livePrEnvironments});
 * - the ownership check on teardown ({@link teardownRefusal}), and the
 *   marker check on every candidate before anything is deleted
 *   ({@link tearDownPrEnvironment});
 * - the sweep over expired and closed pull requests;
 * - the report and the note ({@link renderPrEnvNote}).
 *
 * `chant components pr-env` (../cli/handlers/pr-env.ts) runs these with the
 * components adapter and the lexicons' teardown, and the ports over
 * chant/lifecycle and the gate ledger in ./pr-env-ports.ts
 * (`lifecyclePrEnvPorts`). Those ports load the gate and its schema checks,
 * so they live apart: a product that brings its own ports bundles this
 * module without them (pr-env-run-bundle.test.ts).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutForgeTokens } from "../ci-handover";
import type { ChantConfig } from "../config";
import type { TeardownCandidate, TeardownHole, TeardownOutcome } from "../lexicon";
import type { ObservationLexicon } from "../lexicon";
import {
  PR_ENV_EXIT,
  PR_ENV_GATE,
  expired,
  livePrEnvironments,
  prEnvironmentName,
  renderPrEnvNote,
  teardownComplete,
  teardownCounts,
  tearDownPrEnvironment,
  ttlMs,
  type LivePrEnvironment,
  type PrEnvRecord,
  type PrEnvReport,
  type PrEnvReportRow,
  type PrEnvTeardownAdapter,
  type PrEnvTeardownAdapterInput,
} from "./pr-environment";

/** The environment one run works on. */
export interface PrEnvTarget {
  pr: number;
  /** `pr-<n>`. */
  env: string;
  template: string;
  /** The marker every resource of the environment carries. */
  marker: { stack: string; env: string };
  /** The commit planned and applied: the pull request's head. */
  head: string;
  member?: string;
  /** The op the gate is recorded under: `pr-<n>`, or `pr-<n>-<member>`. */
  op: string;
  endpoint?: string;
}

/** What an adapter's plan came to. */
export interface PrEnvPlanned {
  /** The digest an approval binds. */
  digest: string;
  /** Nothing changes: the plan applies with no approval (ws-104). */
  empty: boolean;
  /** Something failed to plan, or a hook stopped it: nothing applies. */
  failed?: boolean;
  /** One row per component (a Terraform root, a chant component), in apply order. None: the change reaches nothing deployed, and the environment gets nothing. */
  rows: PrEnvReportRow[];
  message?: string;
}

/** What an adapter's apply came to. */
export interface PrEnvApplied {
  /**
   * `waiting`: a component read an upstream output that moved, so it waits
   * for the next run. `stopped`: nothing was applied (a before-apply hook
   * failed), so no record is kept.
   */
  status: "applied" | "failed" | "waiting" | "stopped";
  /** The rows again, with each component's status after the apply. */
  rows: PrEnvReportRow[];
  /** Where each component's copy lives, kept on the record for the teardown (a suffixed state key). */
  locations?: Record<string, string>;
  message?: string;
  /** The apply stands, and something after it failed (an after-apply hook): the record says applied and the run exits 1. */
  afterFailure?: string;
}

/** What `up` hands an adapter's apply: the plan, and who approved it. */
export interface PrEnvApplyInput {
  planned: PrEnvPlanned;
  /** Who approved the digest; absent for an empty plan. */
  approvedBy?: string[];
}

/**
 * The plan and apply of a pull request's environment, which a product
 * supplies. `plan` must not change anything; `apply` applies exactly what
 * `plan` answered, once `up` decided it may.
 */
export interface PrEnvAdapter {
  plan(target: PrEnvTarget): Promise<PrEnvPlanned>;
  apply(target: PrEnvTarget, input: PrEnvApplyInput): Promise<PrEnvApplied>;
}

/** Where the approval of a digest stands, as `decideGate` answers. */
export interface PrEnvApproval {
  status: "approved" | "changed" | "pending";
  approvedBy?: string[];
}

/** What the runs read and write, which tests and products replace. */
export interface PrEnvPorts {
  /** Every record, oldest first. */
  readRecords(): Promise<PrEnvRecord[]>;
  /** Keep one record. A failure should warn: what was applied or torn down stands. */
  appendRecord(record: PrEnvRecord): Promise<void>;
  /** Where the approval of `digest` stands under `gate` of `op`. Throws when the ledger cannot be read. */
  decideGate(input: { op: string; gate: string; digest: string; description: string }): Promise<PrEnvApproval>;
  /** Post the report: the note and the commit status. Absent: nothing is posted. */
  publish?(report: PrEnvReport): Promise<void>;
  /** Whether a pull request is still open, for the sweep. Absent: only the TTL counts. */
  pullRequestState?(pr: number): Promise<"open" | "closed" | "merged">;
  log?(line: string): void;
  warn?(message: string): void;
}

/** What one run came to. */
export interface PrEnvRunResult {
  /** {@link PR_ENV_EXIT}: 0 done, 1 failed or refused, 3 waiting on an approval. */
  exit: number;
  report: PrEnvReport;
  /** The record kept, when the run kept one. */
  record?: PrEnvRecord;
}

/** The op a pull request's gate is recorded under, as `prOp` in ../pr-loop.ts names it. */
export function prEnvOp(pr: number, member?: string): string {
  return member ? `pr-${pr}-${member}` : `pr-${pr}`;
}

/** The approve command an adapter's caller prints, the same the note shows. */
export { prEnvApproveCommand } from "./pr-environment";

// ── up ─────────────────────────────────────────────────────────────────────

export interface PrEnvUpInput {
  pr: number;
  /** The pull request's head, which is planned and applied. */
  head: string;
  /** `ci.prEnvironment.template`, read at base. */
  template: string;
  /** `ci.prEnvironment.ttl`, read at base: `72h`, `90m`, `7d`. Default 72h. */
  ttl?: string;
  /** The ownership stack every resource's marker names. */
  stack: string;
  member?: string;
  endpoint?: string;
  adapter: PrEnvAdapter;
  ports: PrEnvPorts;
  /** Who the record names. Default `chant`. */
  actor?: string;
  runUrl?: string;
  now?: () => Date;
}

const ttlOf = (ttl: string | undefined): number => (ttl ? ttlMs(ttl) : undefined) ?? ttlMs("72h")!;

/**
 * Plan pull request `pr`'s environment through the adapter and apply it once
 * the plan is empty or an approval of its digest stands under gate `pr-env`.
 * An apply that failed part way is kept as live too, so what applied is torn
 * down with the rest.
 */
export async function prEnvUp(input: PrEnvUpInput): Promise<PrEnvRunResult> {
  const { pr, ports } = input;
  const env = prEnvironmentName(pr);
  const target: PrEnvTarget = {
    pr,
    env,
    template: input.template,
    marker: { stack: input.stack, env },
    head: input.head,
    ...(input.member ? { member: input.member } : {}),
    op: prEnvOp(pr, input.member),
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
  };
  const base: PrEnvReport = {
    stage: "up",
    pr,
    env,
    ...(input.member ? { member: input.member } : {}),
    template: input.template,
    head: input.head,
    op: target.op,
    gate: PR_ENV_GATE,
    digest: "",
    status: "nothing",
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    components: [],
  };
  const settle = async (report: PrEnvReport, exit: number, record?: PrEnvRecord): Promise<PrEnvRunResult> => {
    await ports.publish?.(report);
    return { exit, report, ...(record ? { record } : {}) };
  };

  let planned: PrEnvPlanned;
  try {
    planned = await input.adapter.plan(target);
  } catch (err) {
    return settle({ ...base, status: "plan-failed", message: messageOf(err) }, PR_ENV_EXIT.failed);
  }
  if (planned.rows.length === 0) {
    ports.log?.(`pr-env up: nothing this change touches is deployed, so ${env} gets nothing`);
    return settle({ ...base, ...(planned.message ? { message: planned.message } : {}) }, PR_ENV_EXIT.done);
  }
  const digest = planned.digest;
  if (planned.failed) {
    return settle({ ...base, digest, status: "plan-failed", ...(planned.message ? { message: planned.message } : {}), components: planned.rows }, PR_ENV_EXIT.failed);
  }

  // ws-080, ws-104: a non-empty plan applies only under a person's approval of its digest. An empty one passes.
  let approvedBy: string[] | undefined;
  if (!planned.empty) {
    let approval: PrEnvApproval;
    try {
      approval = await ports.decideGate({ op: target.op, gate: PR_ENV_GATE, digest, description: `${env}: ${planned.rows.map((r) => r.component).join(", ")}` });
    } catch (err) {
      return settle({ ...base, digest, status: "failed", message: `could not read the gate ledger, so ${env} does not apply: ${messageOf(err)}`, components: planned.rows }, PR_ENV_EXIT.failed);
    }
    if (approval.status !== "approved") {
      ports.log?.(`pr-env up: ${env} waits for an approval of ${digest}`);
      return settle({ ...base, digest, status: approval.status === "changed" ? "changed" : "waiting", components: planned.rows }, PR_ENV_EXIT.waiting);
    }
    approvedBy = approval.approvedBy ?? [];
  }

  let applied: PrEnvApplied;
  try {
    applied = await input.adapter.apply(target, { planned, ...(approvedBy ? { approvedBy } : {}) });
  } catch (err) {
    applied = { status: "failed", rows: planned.rows, message: messageOf(err) };
  }
  if (applied.status === "stopped") {
    return settle({ ...base, digest, status: "failed", components: applied.rows, ...(approvedBy ? { approvedBy } : {}), ...(applied.message ? { message: applied.message } : {}) }, PR_ENV_EXIT.failed);
  }
  const ok = applied.status === "applied";
  const now = (input.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + ttlOf(input.ttl)).toISOString();
  const record: PrEnvRecord = {
    version: 1,
    kind: "up",
    pr,
    env,
    ...(input.member ? { member: input.member } : {}),
    template: input.template,
    marker: { ...target.marker },
    commit: input.head,
    components: planned.rows.map((r) => r.component),
    ...(applied.locations && Object.keys(applied.locations).length > 0 ? { locations: { ...applied.locations } } : {}),
    planDigest: digest,
    result: ok ? "applied" : "failed",
    by: input.actor ?? "chant",
    timestamp: now.toISOString(),
    expiresAt,
    ...(approvedBy ? { approvedBy } : {}),
    releaseTarget: false,
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
  };
  // A copy that failed part way is live too: what applied is torn down on close or at expiry like the rest.
  await ports.appendRecord(record);
  const message = ok
    ? applied.afterFailure ?? applied.message
    : applied.message ?? (applied.status === "waiting" ? "A component read an upstream output that moved when it applied; run the job again to plan it against the new value." : "A component failed to apply; what applied stays in the environment and is torn down with it.");
  ports.log?.(`pr-env up: ${env} ${ok ? "applied" : applied.status}; it expires ${expiresAt}`);
  return settle(
    { ...base, digest, status: ok ? "applied" : "failed", components: applied.rows, ...(approvedBy ? { approvedBy } : {}), expiresAt, ...(message ? { message } : {}) },
    ok && !applied.afterFailure ? PR_ENV_EXIT.done : PR_ENV_EXIT.failed,
    record,
  );
}

// ── down ───────────────────────────────────────────────────────────────────

/** What tears an environment down: the lexicons, and the adapters a product supplies. */
export interface PrEnvTeardownSources {
  /** The project's config, for its declared environments and stacks. */
  config?: ChantConfig;
  plugins?: ObservationLexicon[];
  adapters?: PrEnvTeardownAdapter[];
}

export interface PrEnvDownInput extends PrEnvTeardownSources {
  pr: number;
  reason: "closed" | "expired";
  member?: string;
  ports: PrEnvPorts;
  /** The environment as the records say it stands. Default: read through `ports`. */
  live?: LivePrEnvironment;
  /** The commit the teardown runs at, for the record. */
  commit: string;
  actor?: string;
  runUrl?: string;
  now?: () => Date;
}

/**
 * Tear down pull request `pr`'s environment: the ownership check first, then
 * only what carries `{ stack, env: "pr-<n>" }`, through the lexicons and the
 * adapters. No gate holds it: closing the pull request, or the TTL the base
 * set, is the decision. A teardown that left something keeps the
 * environment live for the next sweep.
 */
export async function prEnvDown(input: PrEnvDownInput): Promise<PrEnvRunResult> {
  const { pr, ports, reason } = input;
  const env = prEnvironmentName(pr);
  const live = input.live ?? livePrEnvironments(await ports.readRecords()).get(env);
  const report: PrEnvReport = { stage: "down", pr, env, ...(input.member ? { member: input.member } : {}), template: live?.template ?? "", head: "", op: prEnvOp(pr, input.member), gate: PR_ENV_GATE, digest: "", status: "absent", components: [] };
  if (!live) {
    ports.log?.(`pr-env down: ${env} has no live record, so there is nothing to tear down`);
    await ports.publish?.(report);
    return { exit: PR_ENV_EXIT.done, report };
  }
  const torn = await tearDownPrEnvironment({ pr, live, ...(input.config ? { config: input.config } : {}), ...(input.plugins ? { plugins: input.plugins } : {}), ...(input.adapters ? { adapters: input.adapters } : {}), ...(ports.warn ? { warn: ports.warn } : {}) });
  if ("refusal" in torn) {
    const refused = { ...report, template: live.template, status: "refused" as const, message: torn.refusal };
    await ports.publish?.(refused);
    return { exit: PR_ENV_EXIT.failed, report: refused };
  }
  const { report: result, dropped, marker } = torn;
  const counts = teardownCounts(result);
  const complete = teardownComplete(result);
  const now = (input.now ?? (() => new Date()))();
  const record: PrEnvRecord = {
    version: 1,
    kind: "down",
    pr,
    env,
    ...(live.member ? { member: live.member } : {}),
    template: live.template,
    marker,
    commit: input.commit,
    components: [...new Set(result.outcomes.map((o) => o.lexicon))].sort(),
    planDigest: "",
    result: complete ? "destroyed" : "incomplete",
    by: input.actor ?? "chant",
    timestamp: now.toISOString(),
    reason,
    outcomes: counts,
    releaseTarget: false,
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
  };
  await ports.appendRecord(record);
  const why: string[] = [];
  if (dropped > 0) why.push(`${dropped} candidate${dropped === 1 ? "" : "s"} whose marker was not ${marker.stack}/${env} left alone`);
  if (result.unimplemented.length > 0) why.push(`no teardown execution in ${result.unimplemented.join(", ")}`);
  if (result.plan.holes.length > 0) why.push(`${result.plan.holes.length} part${result.plan.holes.length === 1 ? "" : "s"} could not be read`);
  for (const o of result.outcomes.filter((x) => x.outcome === "failed")) why.push(`${o.lexicon} ${o.name}: ${o.detail ?? "failed"}`);
  const done: PrEnvReport = { ...report, template: live.template, status: complete ? "destroyed" : "incomplete", outcomes: counts, ...(why.length > 0 ? { message: why.join("; ") } : {}) };
  ports.log?.(`pr-env down: ${env} ${complete ? "torn down" : "not wholly torn down; it stays live and the sweep tries again"} (${counts.deleted} deleted, ${counts.failed} failed, ${counts.skipped} skipped)`);
  await ports.publish?.(done);
  return { exit: complete ? PR_ENV_EXIT.done : PR_ENV_EXIT.failed, report: done, record };
}

// ── sweep ──────────────────────────────────────────────────────────────────

export interface PrEnvSweepInput extends PrEnvTeardownSources {
  ports: PrEnvPorts;
  /** Only this member's environments. Default: every environment the records name. */
  member?: string;
  commit: string;
  actor?: string;
  runUrl?: string;
  now?: () => Date;
}

/**
 * Tear down each live environment whose TTL passed, or whose pull request
 * the forge says is closed or merged. A state that cannot be read leaves the
 * TTL to decide. Exits 1 when any teardown did not finish.
 */
export async function prEnvSweep(input: PrEnvSweepInput): Promise<{ exit: number; results: PrEnvRunResult[] }> {
  const { ports } = input;
  const live = [...livePrEnvironments(await ports.readRecords()).values()].filter((e) => input.member === undefined || e.member === input.member);
  if (live.length === 0) {
    ports.log?.("pr-env sweep: no pull request environment is live");
    return { exit: PR_ENV_EXIT.done, results: [] };
  }
  const now = (input.now ?? (() => new Date()))();
  let exit: number = PR_ENV_EXIT.done;
  const results: PrEnvRunResult[] = [];
  for (const e of live) {
    let reason: "closed" | "expired" | undefined = expired(e, now) ? "expired" : undefined;
    if (!reason && ports.pullRequestState) {
      try {
        if ((await ports.pullRequestState(e.pr)) !== "open") reason = "closed";
      } catch (err) {
        ports.warn?.(`could not read whether #${e.pr} is open (${messageOf(err)}); its TTL still holds`);
      }
    }
    if (!reason) {
      ports.log?.(`pr-env sweep: ${e.env} stays; it expires ${e.expiresAt}`);
      continue;
    }
    const r = await prEnvDown({ ...input, pr: e.pr, reason, live: e, ...(e.member ? { member: e.member } : {}) });
    results.push(r);
    if (r.exit !== PR_ENV_EXIT.done) exit = PR_ENV_EXIT.failed;
  }
  return { exit, results };
}

// ── a teardown command ─────────────────────────────────────────────────────

/** `ci.prEnvironment.teardown` (#4330): a command that tears down what no lexicon does. */
export interface PrEnvTeardownCommand {
  /** The name its outcomes are attributed to. Default `teardown`. */
  name?: string;
  /** Argv. `{env}`, `{pr}` and `{stage}` are filled in. */
  command: string[];
  /** The lexicons it tears down in place of, as {@link PrEnvTeardownAdapter.lexicons}. */
  lexicons?: string[];
}

/** The variables a teardown command reads. */
export const PR_ENV_TEARDOWN_ENV = {
  /** `owned` or `teardown`. */
  stage: "CHANT_PR_ENV_STAGE",
  /** `pr-<n>`. */
  env: "CHANT_PR_ENV",
  pr: "CHANT_PR_NUMBER",
  stack: "CHANT_PR_ENV_STACK",
  template: "CHANT_PR_ENV_TEMPLATE",
  /** The commit last applied to the environment. */
  commit: "CHANT_PR_ENV_COMMIT",
  /** A JSON file: `{ components, locations }` from the records. */
  live: "CHANT_PR_ENV_LIVE",
  /** `teardown` only: a JSON file holding the candidates to delete. */
  candidates: "CHANT_PR_ENV_CANDIDATES",
  /** The JSON file the command writes its answer to. */
  result: "CHANT_PR_ENV_RESULT",
} as const;

/** Runs one argv in `cwd` with `env` as its whole environment; returns its exit code. Injected so tests run no processes. */
export type PrEnvTeardownExec = (argv: string[], cwd: string, env: Record<string, string>) => number;

const spawnTeardown: PrEnvTeardownExec = (argv, cwd, env) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
  if (r.error) throw r.error;
  return r.status ?? 1;
};

const MARKER_OK = (m: unknown): m is { stack: string; env: string } => typeof m === "object" && m !== null && typeof (m as { stack?: unknown }).stack === "string" && typeof (m as { env?: unknown }).env === "string";

/** The candidates and holes a teardown command wrote, checked as data. Throws when they do not read. */
export function readTeardownEnumeration(raw: unknown): { candidates: TeardownCandidate[]; holes: TeardownHole[] } {
  const doc = raw as { candidates?: unknown; holes?: unknown } | null;
  if (typeof doc !== "object" || doc === null || !Array.isArray(doc.candidates)) throw new Error("the teardown command's owned stage wrote no { candidates: [...] }");
  const candidates: TeardownCandidate[] = [];
  for (const c of doc.candidates as Array<Record<string, unknown>>) {
    if (typeof c?.name !== "string" || typeof c.type !== "string" || !MARKER_OK(c.marker)) throw new Error("each candidate needs a name, a type and the marker { stack, env } read back from it");
    candidates.push({ name: c.name, type: c.type, ...(typeof c.physicalId === "string" ? { physicalId: c.physicalId } : {}), marker: { stack: c.marker.stack, env: c.marker.env } });
  }
  const holes: TeardownHole[] = [];
  for (const h of Array.isArray(doc.holes) ? (doc.holes as Array<Record<string, unknown>>) : []) {
    if (typeof h?.name !== "string") continue;
    holes.push({ name: h.name, reason: "read-failed", ...(typeof h.type === "string" ? { type: h.type } : {}), ...(typeof h.detail === "string" ? { detail: h.detail } : {}) });
  }
  return { candidates, holes };
}

/** The outcomes a teardown command wrote, checked as data. A candidate it leaves out counts as failed in core. */
export function readTeardownOutcomes(raw: unknown): TeardownOutcome[] {
  const doc = raw as { outcomes?: unknown } | null;
  if (typeof doc !== "object" || doc === null || !Array.isArray(doc.outcomes)) throw new Error("the teardown command's teardown stage wrote no { outcomes: [...] }");
  const kinds = new Set(["deleted", "failed", "not-prunable", "retained"]);
  return (doc.outcomes as Array<Record<string, unknown>>)
    .filter((o) => typeof o?.name === "string" && typeof o.outcome === "string" && kinds.has(o.outcome))
    .map((o) => ({ name: o.name as string, outcome: o.outcome as TeardownOutcome["outcome"], ...(typeof o.detail === "string" ? { detail: o.detail } : {}) }));
}

/**
 * `ci.prEnvironment.teardown` as an adapter (#4330). chant runs the command
 * twice, in `cwd`, with the job's environment less every forge token
 * variable, and these besides ({@link PR_ENV_TEARDOWN_ENV}):
 *
 * - `CHANT_PR_ENV_STAGE=owned`: the command writes `{ candidates, holes }`
 *   to `CHANT_PR_ENV_RESULT`, each candidate with the marker it read back.
 * - `CHANT_PR_ENV_STAGE=teardown`: it deletes the candidates in
 *   `CHANT_PR_ENV_CANDIDATES`, which chant has checked against the marker,
 *   and writes `{ outcomes }` to `CHANT_PR_ENV_RESULT`.
 *
 * A non-zero exit, or an answer that does not read, is a hole (`owned`) or a
 * failure for every candidate (`teardown`), so the environment stays live.
 */
export function commandTeardownAdapter(hook: PrEnvTeardownCommand, opts: { cwd: string; env?: Record<string, string | undefined>; exec?: PrEnvTeardownExec }): PrEnvTeardownAdapter {
  const exec = opts.exec ?? spawnTeardown;
  const name = hook.name ?? "teardown";
  const run = (stage: "owned" | "teardown", input: PrEnvTeardownAdapterInput, candidates?: TeardownCandidate[]): unknown => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pr-env-teardown-"));
    try {
      const result = join(dir, "result.json");
      const liveFile = join(dir, "live.json");
      writeFileSync(liveFile, JSON.stringify({ components: input.live.components, locations: input.live.locations ?? {} }));
      const extra: Record<string, string> = {
        [PR_ENV_TEARDOWN_ENV.stage]: stage,
        [PR_ENV_TEARDOWN_ENV.env]: input.environment,
        [PR_ENV_TEARDOWN_ENV.pr]: String(input.live.pr),
        [PR_ENV_TEARDOWN_ENV.stack]: input.marker.stack,
        [PR_ENV_TEARDOWN_ENV.template]: input.live.template,
        [PR_ENV_TEARDOWN_ENV.commit]: input.live.commit,
        [PR_ENV_TEARDOWN_ENV.live]: liveFile,
        [PR_ENV_TEARDOWN_ENV.result]: result,
      };
      if (candidates) {
        const file = join(dir, "candidates.json");
        writeFileSync(file, JSON.stringify(candidates));
        extra[PR_ENV_TEARDOWN_ENV.candidates] = file;
      }
      const base: Record<string, string> = {};
      for (const [k, v] of Object.entries(withoutForgeTokens(opts.env ?? process.env))) if (v !== undefined) base[k] = v;
      const argv = hook.command.map((a) => a.split("{env}").join(input.environment).split("{pr}").join(String(input.live.pr)).split("{stage}").join(stage));
      const code = exec(argv, opts.cwd, { ...base, ...extra });
      if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code} in its ${stage} stage`);
      let text: string;
      try {
        text = readFileSync(result, "utf-8");
      } catch {
        throw new Error(`${argv.join(" ")} wrote nothing to ${PR_ENV_TEARDOWN_ENV.result} in its ${stage} stage`);
      }
      return JSON.parse(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    name,
    ...(hook.lexicons ? { lexicons: [...hook.lexicons] } : {}),
    async owned(input) {
      return readTeardownEnumeration(run("owned", input));
    },
    async teardown(input) {
      try {
        return { outcomes: readTeardownOutcomes(run("teardown", input, input.candidates)) };
      } catch (err) {
        return { outcomes: input.candidates.map((c) => ({ name: c.name, outcome: "failed" as const, detail: messageOf(err) })) };
      }
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
