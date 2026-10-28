/**
 * The harness's scenario driver (chant#4587). It runs a scenario's steps in
 * order against the forge, the report bucket, chant, the ledger and the
 * runner's jobs as interfaces (./ports.ts), once as the plain run and once as
 * the BREAK run, and checks each step's outcomes against chant's own reports
 * and run ledger, never the runner's status or logs.
 *
 * A pull request comes from the driver's own open step or from a product:
 * an await-pull step waits for the one a product opened from its branch
 * (chant#4650), and later steps name it as they name an open step's.
 *
 * A run ends one of three ways. Every outcome held: the plain run passes, and
 * a BREAK run that ends so was missed. An outcome did not hold: the run stops
 * there, the plain run fails, and the BREAK run was caught. A step did not
 * finish (past its limit, or an error): the run stalled, which is neither.
 */
import { reportKey } from "../pr-report-url";
import type { GatedRequestRead } from "../lifecycle/gated-request";
import type { OpRunRecord } from "../op/runtime";
import type { Bucket, Chant, Clock, ForgePull, ForgeReads, Jobs, Ledger, Log, OutOfBand, PullForge } from "./ports";
import { componentStatuses, reportObjectKey, splitReportUrl, waitForReport, type PrReportView, type ReportStage } from "./reports";
import type { BreakVerdict, PlainVerdict, Scenario, ScenarioOutcome, ScenarioStep, ScenarioStepKind } from "./schemas/index";
import { limitsFor } from "./steps";

export type Arm = "plain" | "break";

export interface DriverPorts {
  forge: PullForge & Partial<ForgeReads>;
  /** The bucket the scenario's report URL names. */
  bucket: Bucket;
  chant: Pick<Chant, "approve">;
  clock: Clock;
  /** An overlay's files, repo-relative path to content. */
  overlay(name: string): Record<string, string>;
  ledger?: Ledger;
  jobs?: Jobs;
  outOfBand?: OutOfBand;
  /** Put the repo and the stacks back to the base, before each run. */
  reset?(): Promise<void>;
  /** Hand the run's environment to where the pipeline reads it (the runner's secrets file). */
  arm?(arm: Arm, env: Record<string, string>): Promise<void>;
  log?: Log;
}

export interface DriverOptions {
  /** Who approves, as chant names reviewers: `forgejo@forgejo:3000:<login>`. */
  approver: string;
  /** How often reports are polled, in ms. Default 2000. */
  pollMs?: number;
}

export interface StepResult {
  id: string;
  do: ScenarioStepKind;
  pull?: number;
  commit?: string;
  /** Why the run stopped at this step. */
  stopped?: { outcome: "broke" | "stalled"; reason: string };
}

export interface ArmRun {
  scenario: string;
  arm: Arm;
  outcome: "held" | "broke" | "stalled";
  reason?: string;
  started: string;
  ended: string;
  steps: StepResult[];
}

/** A step past its limit or one that errored: the run stalls. */
class Stall extends Error {}
/** An outcome that did not hold: the run broke. */
class Broke extends Error {}

interface Opened {
  pull: number;
  head: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** How a gated request stands: gated until a finished line names it, then ok or failed. */
function gatedStatus(r: GatedRequestRead): "gated" | "ok" | "failed" {
  if (!r.finished) return "gated";
  return r.finished.result === "applied" ? "ok" : "failed";
}

/** The check of one outcome, or null when it holds. */
async function checkOutcome(
  o: ScenarioOutcome,
  ctx: { report?: PrReportView; pull?: number; exit?: number; since: string; env: string },
  p: DriverPorts,
): Promise<string | null> {
  if ("report" in o) {
    const r = ctx.report;
    if (!r) return "no report to read";
    if (o.report.status !== undefined && r.status !== o.report.status) return `the ${r.stage} report ended ${r.status}, not ${o.report.status}`;
    if (o.report.components) {
      const s = componentStatuses(r);
      for (const [name, want] of Object.entries(o.report.components)) {
        if (s.get(name) !== want) return `${name} is ${s.get(name) ?? "missing"} in the ${r.stage} report, not ${want}`;
      }
      if (o.report.only) {
        const extra = [...s.keys()].filter((k) => !(k in o.report.components!));
        if (extra.length > 0) return `the ${r.stage} report reaches ${extra.join(", ")} beyond the ones named`;
      }
    }
    return null;
  }
  if ("ledger" in o) {
    if (!p.ledger) throw new Stall("a ledger outcome needs the ledger port");
    const runs = (await p.ledger.runs(ctx.env, o.ledger.op)).filter((r: OpRunRecord) => r.started >= ctx.since);
    const matching = o.ledger.status ? runs.filter((r) => r.status === o.ledger.status) : runs;
    if (o.ledger.count !== undefined) {
      return matching.length === o.ledger.count ? null : `${matching.length} ${o.ledger.op} runs${o.ledger.status ? ` ${o.ledger.status}` : ""} on the ledger, not ${o.ledger.count}`;
    }
    return matching.length > 0 ? null : `no ${o.ledger.op} run${o.ledger.status ? ` ${o.ledger.status}` : ""} on the ledger since the run started`;
  }
  if ("gated" in o) {
    if (!p.ledger?.gatedRequests) throw new Stall("a gated outcome needs the ledger's gated requests");
    const asked = (await p.ledger.gatedRequests(o.gated.op)).filter((r) => r.pending.timestamp >= ctx.since);
    const matching = o.gated.status ? asked.filter((r) => gatedStatus(r) === o.gated.status) : asked;
    const status = o.gated.status ? ` ${o.gated.status}` : "";
    if (o.gated.count !== undefined) {
      return matching.length === o.gated.count ? null : `${matching.length} gated ${o.gated.op} requests${status} on the ledger, not ${o.gated.count}`;
    }
    return matching.length > 0 ? null : `no gated ${o.gated.op} request${status} on the ledger since the run started`;
  }
  if ("pull" in o) {
    if (ctx.pull === undefined) return "no pull request to read";
    if (o.pull.title !== undefined) {
      if (!p.forge.pullInfo) throw new Stall("a pull outcome with a title needs the forge's pull requests");
      const info = await p.forge.pullInfo(ctx.pull);
      if (!info) return `the forge does not know pull request ${ctx.pull}`;
      if (!info.title.includes(o.pull.title)) return `pull request ${ctx.pull} is titled "${info.title}", which does not hold "${o.pull.title}"`;
    }
    if (o.pull.files !== undefined) {
      if (!p.forge.changedFiles) throw new Stall("a pull outcome with files needs the forge's changed files");
      const changed = await p.forge.changedFiles(ctx.pull);
      const missing = o.pull.files.filter((f) => !changed.includes(f));
      if (missing.length > 0) return `pull request ${ctx.pull} does not change ${missing.join(", ")}`;
      if (o.pull.only) {
        const extra = changed.filter((f) => !o.pull.files!.includes(f));
        if (extra.length > 0) return `pull request ${ctx.pull} also changes ${extra.join(", ")} beyond the files named`;
      }
    }
    return null;
  }
  if ("comment" in o) {
    if (!p.forge.comments) throw new Stall("a comment outcome needs the forge's comments");
    if (ctx.pull === undefined) return "no pull request to read comments of";
    const bodies = await p.forge.comments(ctx.pull);
    return bodies.some((b) => b.includes(o.comment)) ? null : `no comment on pull request ${ctx.pull} holds "${o.comment}"`;
  }
  if ("issue" in o) {
    if (!p.forge.issues) throw new Stall("an issue outcome needs the forge's issues");
    const found = (await p.forge.issues()).filter((i) => i.title.includes(o.issue.title));
    const want = o.issue.open === undefined ? found : found.filter((i) => i.open === o.issue.open);
    return want.length > 0 ? null : `no ${o.issue.open === false ? "closed " : o.issue.open ? "open " : ""}issue titled "${o.issue.title}"`;
  }
  return ctx.exit === o.exit ? null : `the command exited ${ctx.exit ?? "nothing"}, not ${o.exit}`;
}

/** Run one arm of a scenario. */
export async function runArm(s: Scenario, arm: Arm, p: DriverPorts, opts: DriverOptions): Promise<ArmRun> {
  const limits = limitsFor(s.limits);
  const env = s.env ?? "local";
  const { prefix } = splitReportUrl(s.reportUrl);
  const log = p.log ?? (() => {});
  const startedMs = p.clock.now();
  const since = iso(startedMs);
  const opened = new Map<string, Opened>();
  const merged = new Map<string, { pull: number; commit: string }>();
  const plans = new Map<string, PrReportView>();
  const results: StepResult[] = [];
  const done = (outcome: ArmRun["outcome"], reason?: string): ArmRun => ({
    scenario: s.id,
    arm,
    outcome,
    ...(reason ? { reason } : {}),
    started: since,
    ended: iso(p.clock.now()),
    steps: results,
  });

  const files = (overlay: string): Record<string, string> => ({
    ...p.overlay(overlay),
    ...(arm === "break" && s.break.overlay ? p.overlay(s.break.overlay) : {}),
  });
  const branchOf = (b: string) => (arm === "break" ? `${b}-break` : b);
  const deadlineOf = (kind: ScenarioStepKind) => p.clock.now() + limits[kind] * 1000;
  const report = async (stage: ReportStage, pr: number, commit: string, kind: ScenarioStepKind): Promise<PrReportView> => {
    const key = reportObjectKey(prefix, pr, commit, stage);
    const r = await waitForReport(p.bucket, key, p.clock, deadlineOf(kind), opts.pollMs ?? 2000);
    if (!r) throw new Stall(`no pr-${stage}.json at ${reportKey(pr, commit)} within ${limits[kind]}s`);
    return r;
  };
  // Forge and chant calls carry their own timeouts; a call that came back
  // after its step's limit stalls the run all the same.
  const within = async <T>(kind: ScenarioStepKind, work: Promise<T>): Promise<T> => {
    const deadline = deadlineOf(kind);
    const out = await work;
    if (p.clock.now() > deadline) throw new Stall(`${kind} did not finish within ${limits[kind]}s`);
    return out;
  };
  const open = async (step: Extract<ScenarioStep, { do: "open" | "open-concurrent" }>): Promise<StepResult> => {
    const head = await within(step.do, p.forge.pushBranch(branchOf(step.branch), files(step.overlay), step.title));
    const pull = await within(step.do, p.forge.openPull(branchOf(step.branch), step.title, step.body ?? step.title));
    opened.set(step.id, { pull, head });
    log(`${s.id} ${arm}: ${step.id} opened pull request ${pull} at ${head.slice(0, 8)}`);
    return { id: step.id, do: step.do, pull, commit: head };
  };
  const pullOf = (id: string): Opened => {
    const o = opened.get(id);
    if (!o) throw new Stall(`no pull request from ${id}`);
    return o;
  };
  // The pull requests open when the run started. await-pull never binds one
  // of these, so the BREAK run cannot pick up the plain run's pull request
  // when the reset left it open.
  let before = new Set<number>();
  const awaitPull = async (step: Extract<ScenarioStep, { do: "await-pull" }>): Promise<StepResult> => {
    const find = p.forge.findPull;
    if (!find) throw new Stall("an await-pull step needs the forge's findPull");
    // The product picks the branch, so it is the same on both runs.
    const deadline = deadlineOf("await-pull");
    let seen: ForgePull | undefined;
    for (;;) {
      const found = await find.call(p.forge, step.branch);
      if (found && !before.has(found.number) && (step.title === undefined || found.title.includes(step.title))) {
        opened.set(step.id, { pull: found.number, head: found.head });
        log(`${s.id} ${arm}: ${step.id} found pull request ${found.number} at ${found.head.slice(0, 8)}`);
        return { id: step.id, do: step.do, pull: found.number, commit: found.head };
      }
      if (found) seen = found;
      if (p.clock.now() >= deadline) break;
      await p.clock.sleep(opts.pollMs ?? 2000);
    }
    const why = !seen
      ? `no open pull request from ${step.branch} within ${limits["await-pull"]}s`
      : before.has(seen.number)
        ? `pull request ${seen.number} from ${step.branch} was open before the run started, and no new one came within ${limits["await-pull"]}s`
        : `pull request ${seen.number} from ${step.branch} is titled "${seen.title}", which does not hold "${step.title}", after ${limits["await-pull"]}s`;
    throw new Stall(why);
  };

  try {
    await p.reset?.();
    await p.arm?.(arm, arm === "break" ? { ...s.break.env } : {});
    if (s.steps.some((x) => x.do === "await-pull")) before = new Set(await p.forge.openPulls());
    for (let i = 0; i < s.steps.length; i++) {
      const step = s.steps[i]!;
      let result: StepResult;
      const ctx: { report?: PrReportView; pull?: number; exit?: number; since: string; env: string } = { since, env };
      switch (step.do) {
        case "open":
        case "open-concurrent": {
          // An open and the open-concurrent steps after it go out together.
          const group = [step];
          while (s.steps[i + 1]?.do === "open-concurrent") group.push(s.steps[++i] as typeof step);
          const all = await Promise.all(group.map((g) => open(g as Extract<ScenarioStep, { do: "open" | "open-concurrent" }>)));
          for (let g = 0; g < group.length; g++) {
            const gs = group[g]!;
            const r = all[g]!;
            for (const o of gs.expect ?? []) {
              const why = await checkOutcome(o, { ...ctx, pull: r.pull }, p);
              if (why) {
                results.push({ ...r, stopped: { outcome: "broke", reason: why } });
                throw new Broke(`${gs.id}: ${why}`);
              }
            }
            results.push(r);
          }
          continue;
        }
        case "await-pull": {
          result = await awaitPull(step);
          ctx.pull = result.pull;
          break;
        }
        case "plan": {
          const o = pullOf(step.pull);
          const r = await report("plan", o.pull, o.head, "plan");
          plans.set(step.pull, r);
          ctx.report = r;
          ctx.pull = o.pull;
          result = { id: step.id, do: step.do, pull: o.pull, commit: o.head };
          break;
        }
        case "approve": {
          const o = pullOf(step.pull);
          const plan = plans.get(step.pull) ?? (await report("plan", o.pull, o.head, "approve"));
          await within("approve", p.forge.approvePull(o.pull, `Approved by the e2e harness (${s.id}, ${arm}).`));
          await within("approve", p.chant.approve({ pull: o.pull, op: plan.op, gate: plan.gate, digest: plan.digest, approver: opts.approver }));
          ctx.pull = o.pull;
          result = { id: step.id, do: step.do, pull: o.pull };
          break;
        }
        case "merge": {
          const o = pullOf(step.pull);
          const commit = await within("merge", p.forge.mergePull(o.pull));
          merged.set(step.id, { pull: o.pull, commit });
          ctx.pull = o.pull;
          result = { id: step.id, do: step.do, pull: o.pull, commit };
          break;
        }
        case "comment": {
          const o = pullOf(step.pull);
          const post = p.forge.postComment;
          if (!post) throw new Stall("a comment step needs the forge's postComment");
          await within("comment", post.call(p.forge, o.pull, step.body, step.as ?? "author"));
          log(`${s.id} ${arm}: ${step.id} commented on pull request ${o.pull} as ${step.as ?? "author"}`);
          ctx.pull = o.pull;
          result = { id: step.id, do: step.do, pull: o.pull };
          break;
        }
        case "apply": {
          const m = merged.get(step.merge);
          if (!m) throw new Stall(`no merge from ${step.merge}`);
          ctx.report = await report("apply", m.pull, m.commit, "apply");
          ctx.pull = m.pull;
          result = { id: step.id, do: step.do, pull: m.pull, commit: m.commit };
          break;
        }
        case "out-of-band": {
          if (!p.outOfBand) throw new Stall("an out-of-band step needs the out-of-band port");
          ctx.exit = await within("out-of-band", p.outOfBand.run(step.command));
          result = { id: step.id, do: step.do };
          break;
        }
        case "kill-job": {
          if (!p.jobs) throw new Stall("a kill-job step needs the jobs port");
          const killed = await within("kill-job", p.jobs.kill(step.match));
          if (!killed) throw new Stall(`no running job${step.match ? ` matching ${step.match}` : ""} to kill`);
          result = { id: step.id, do: step.do };
          break;
        }
      }
      for (const o of step.expect ?? []) {
        const why = await checkOutcome(o, ctx, p);
        if (why) {
          results.push({ ...result, stopped: { outcome: "broke", reason: why } });
          throw new Broke(`${step.id}: ${why}`);
        }
      }
      results.push(result);
      log(`${s.id} ${arm}: ${step.id} held`);
    }
    return done("held");
  } catch (err) {
    if (err instanceof Broke) return done("broke", err.message);
    const reason = err instanceof Error ? err.message : String(err);
    const at = s.steps[results.length]?.id;
    if (at && !results.some((r) => r.stopped)) results.push({ id: at, do: s.steps[results.length]!.do, stopped: { outcome: "stalled", reason } });
    return done("stalled", at ? `${at}: ${reason}` : reason);
  }
}

/** The row's verdicts from the two runs. */
export function verdictsOf(plain: Pick<ArmRun, "outcome">, brk: Pick<ArmRun, "outcome">): { plain: PlainVerdict; break: BreakVerdict } {
  return {
    plain: plain.outcome === "held" ? "pass" : "fail",
    break: brk.outcome === "broke" ? "caught" : brk.outcome === "held" ? "missed" : "stalled",
  };
}

export interface ClaimRun {
  plain: ArmRun;
  break: ArmRun;
  verdicts: { plain: PlainVerdict; break: BreakVerdict };
}

/** The plain run, then the BREAK run, and their verdicts. */
export async function runClaim(s: Scenario, p: DriverPorts, opts: DriverOptions): Promise<ClaimRun> {
  const plain = await runArm(s, "plain", p, opts);
  const brk = await runArm(s, "break", p, opts);
  return { plain, break: brk, verdicts: verdictsOf(plain, brk) };
}
