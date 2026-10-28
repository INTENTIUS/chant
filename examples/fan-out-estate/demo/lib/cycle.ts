/**
 * One cycle of the fan-out demo (#4085 sections 1 and 2), against the forge,
 * the bucket and chant as interfaces (ports.ts), so a test runs it in
 * process.
 *
 * A cycle is two pull requests and a reset, in four chapters. The change
 * opens, pr-plan plans fifteen stacks, the reviewer approves, the author
 * merges, and pr-apply fails cluster-a and blocks its six apps while the
 * other eight apply. The fix opens and goes the same way, and pr-apply
 * applies the seven. The reset puts the forge repo and the stacks back to the
 * base, so the next cycle fails the same way.
 *
 * The driver waits on chant's reports below the report URL
 * (`<pr>/<commit>/pr-plan.json` and `pr-apply.json`, keyed by reportKey),
 * never on the forge's run status or its logs, and reads the failure from
 * pr-apply.json's `members[].status`. It writes demo-step/v1 to step.json at
 * every step, validated first, and publishes demo-cycle/v1 at a full cycle's
 * reset. A step past its time limit writes stalled, and the cycle resets and
 * is never published.
 */
import { reportKey } from "../../../../packages/core/src/pr-report-url.js";
import { componentStatuses, type PrReportView } from "../../../../packages/core/src/e2e-harness/reports.js";
import {
  validateDemoCycle,
  validateDemoStep,
  type DemoChapter,
  type DemoCycle,
  type DemoCycleReport,
  type DemoStep,
  type DemoStepName,
} from "../schemas/index.js";
import {
  ABOUT,
  BUCKET,
  DEMO,
  FIXED,
  FORGE_HOST,
  HELD,
  HOLDS,
  LIMITS,
  NAME,
  NEXT,
  PREFIX,
  PULL_TITLE,
  REPO,
  REPORT_URL,
  REVIEWER,
  SCENARIO,
  TITLE,
  WAVES,
  WENT,
  BASE_LABEL,
  branchFor,
  chapterFor,
  highlightFor,
  labelFor,
  resetLabel,
  stalledLabel,
  type About,
  type HoldName,
  type Highlight,
  type LimitName,
  type Round,
} from "../steps.js";
import type { Bucket, Chant, Clock, Forge, Log } from "./ports.js";

export const STEP_SCHEMA = "https://intentius.io/chant/schemas/demo/demo-step/v1/demo-step.schema.json";
export const CYCLE_SCHEMA = "https://intentius.io/chant/schemas/demo/demo-cycle/v1/demo-cycle.schema.json";

/** demo-step/v1 as this driver writes it. `highlight` is an addition within contract 1. */
export type StepRecord = DemoStep & { highlight?: Highlight | null };

/** Keys below the bucket. */
export const KEYS = {
  step: `${PREFIX}/step.json`,
  cycles: `${PREFIX}/cycles/`,
  latest: `${PREFIX}/cycles/latest.json`,
  cycle: (n: number) => `${PREFIX}/cycles/${n}.json`,
  /** A report file below the report URL, as the bucket names it. */
  report: (key: string, file: string) => `${REPORT_URL.slice(`s3://${BUCKET}/`.length)}/${key}/${file}`,
};

/** The newest cycles kept in cycles/. */
export const CYCLES_KEPT = 5;

/** What a cycle needs. */
export interface CycleDeps {
  forge: Forge;
  bucket: Bucket;
  chant: Chant;
  clock: Clock;
  /** The files a round copies over the base, `@CYCLE@` filled in. */
  overlays: (round: Round, cycle: number) => Record<string, string>;
  /** The base commit every reset forces main back to. */
  baseSha: string;
  log?: Log;
  /** Hold and limit seconds, when not the ones in steps.ts. */
  holds?: Partial<Record<HoldName, number>>;
  limits?: Partial<Record<LimitName, number>>;
  /** Seconds between two looks at the bucket while waiting on a report. */
  pollSeconds?: number;
  /**
   * Seconds between two writes of the same step while the driver waits on a
   * report, so a reader sees the driver is alive. The rewrite keeps the
   * step's label, next and highlight; only `at` moves. It goes to step.json
   * only, not into the cycle's steps.
   */
  refreshSeconds?: number;
}

/** How a cycle ended. */
export type CycleOutcome =
  | { status: "applied"; cycle: number; published: DemoCycle }
  | { status: "stalled"; cycle: number; after: string; reason: string };

/** A step past its limit, or a fact that is not what the story says. The cycle stalls. */
export class Stall extends Error {}

// pr-report/v1 and each component's status in it, as the e2e harness reads them.
export { componentStatuses };

/** The change's apply ended as the story says: cluster-a failed, its six apps blocked, the other eight applied. */
export function checkChangeApply(report: Pick<PrReportView, "status" | "members">): string | null {
  if (report.status !== "failed") return `the change's apply ended ${report.status}, where cluster-a should fail`;
  const s = componentStatuses(report);
  if (s.get("cluster-a") !== "failed") return `cluster-a is not the stack that failed (it is ${s.get("cluster-a") ?? "missing"})`;
  for (const m of HELD) if (s.get(m) !== "blocked") return `${m} was not blocked by cluster-a's failure (it is ${s.get(m) ?? "missing"})`;
  for (const m of WENT) if (s.get(m) !== "applied") return `${m} did not apply beside cluster-a's failure (it is ${s.get(m) ?? "missing"})`;
  return null;
}

/** The fix's apply applied the seven and nothing else. */
export function checkFixApply(report: Pick<PrReportView, "status" | "members">): string | null {
  if (report.status !== "applied") return `the fix's apply ended ${report.status}`;
  const s = componentStatuses(report);
  for (const m of FIXED) if (s.get(m) !== "applied") return `the fix did not apply ${m} (it is ${s.get(m) ?? "missing"})`;
  const extra = [...s.keys()].filter((m) => !(FIXED as readonly string[]).includes(m));
  if (extra.length > 0) return `the fix's apply reached ${extra.join(", ")}, beyond the seven`;
  return null;
}

/** The plan selected what the story says: fifteen in three waves for the change, the seven for the fix. */
export function checkPlan(round: Round, report: Pick<PrReportView, "status" | "selection">): string | null {
  if (report.status !== "planned") return `the ${round}'s plan ended ${report.status}`;
  const waves = report.selection.waves.map((w) => [...w].sort());
  const want = round === "change" ? WAVES.map((w) => [...w].sort()) : [["cluster-a"], [...HELD].sort()];
  if (JSON.stringify(waves) !== JSON.stringify(want)) {
    return `the ${round}'s plan has waves ${JSON.stringify(report.selection.waves)}, not ${JSON.stringify(want)}`;
  }
  return null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The last cycle step.json names, 0 when there is none. */
export async function lastCycle(bucket: Bucket): Promise<number> {
  const text = await bucket.get(KEYS.step);
  if (!text) return 0;
  try {
    const n = (JSON.parse(text) as { cycle?: unknown }).cycle;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** One cycle of the demo, from its first push to its reset. */
export class DemoCycleRun {
  readonly cycle: number;
  private readonly d: CycleDeps;
  private readonly holds: Record<HoldName, number>;
  private readonly limits: Record<LimitName, number>;
  private readonly log: Log;
  private readonly started: number;
  /** Every step as written, in order. */
  readonly steps: StepRecord[] = [];
  /** Every stage's report key, in run order. */
  readonly reports: DemoCycleReport[] = [];
  private round: Round | null = null;
  private pull: number | null = null;
  private commit: string | undefined;
  private about: About | undefined;
  private planKey: string | undefined;
  private applyKey: string | undefined;
  private lastChapter: DemoChapter | null = null;
  private lastStep: string = "the start";
  /** The step written last, to write again while waiting. */
  private current: { step: DemoStepName; label?: string; next?: StepRecord["next"] } | undefined;
  private lastWriteAt = 0;

  constructor(cycle: number, deps: CycleDeps) {
    this.cycle = cycle;
    this.d = deps;
    this.holds = { ...HOLDS, ...deps.holds };
    this.limits = { ...LIMITS, ...deps.limits };
    this.log = deps.log ?? (() => {});
    this.started = deps.clock.now();
  }

  /** Play the cycle. Never throws for a stall: it writes stalled, resets and says so. */
  async run(): Promise<CycleOutcome> {
    try {
      await this.playRound("change");
      await this.hold("failed", "failed");
      this.about = ABOUT.fix;
      await this.playRound("fix");
      // The applied step holds while the reset's work goes on behind it.
      const endAt = this.d.clock.now() + this.holds.end * 1000;
      await this.write("applied", { next: { action: NEXT.applied!, from: iso(this.d.clock.now()), at: iso(endAt) } });
      await this.resetWork();
      const left = endAt - this.d.clock.now();
      if (left > 0) await this.d.clock.sleep(left);
      this.pull = null;
      this.commit = this.d.baseSha;
      await this.write("reset", { label: resetLabel(this.d.baseSha) });
      const published = await this.publish();
      return { status: "applied", cycle: this.cycle, published };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const after = this.lastStep;
      this.log(`cycle ${this.cycle}: stalled after ${after}: ${reason}`);
      await this.writeStalled(after, reason);
      try {
        await this.resetWork();
        this.round = null;
        this.pull = null;
        this.commit = this.d.baseSha;
        this.about = undefined;
        await this.write("reset", { label: BASE_LABEL });
      } catch (resetErr) {
        this.log(`cycle ${this.cycle}: the reset after the stall failed too: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}`);
      }
      return { status: "stalled", cycle: this.cycle, after, reason };
    }
  }

  /** One pull request: opened, planned, approved, merged, and its apply read. */
  private async playRound(round: Round): Promise<void> {
    this.round = round;
    this.about ??= ABOUT[round];
    this.pull = null;
    this.planKey = undefined;
    this.applyKey = undefined;

    const files = this.d.overlays(round, this.cycle);
    const branch = branchFor(round, this.cycle);
    const head = await this.limited("open", async () => {
      const sha = await this.d.forge.pushBranch(branch, files, `${PULL_TITLE[round]} (cycle ${this.cycle})`);
      const pull = await this.d.forge.openPull(branch, PULL_TITLE[round], `Cycle ${this.cycle} of the chant fan-out demo (examples/fan-out-estate/demo).`);
      return { sha, pull };
    });
    this.pull = head.pull;
    this.commit = head.sha;
    await this.write("pull-request");

    const planKey = reportKey(this.pull, head.sha);
    const plan = await this.waitReport(planKey, "pr-plan.json", "plan", (r) => r.stage === "plan" && r.status !== undefined);
    const planWrong = checkPlan(round, plan);
    if (planWrong) throw new Stall(planWrong);
    this.planKey = planKey;
    this.addReport("plan", this.pull, head.sha, planKey);

    await this.hold("planned", round === "change" ? "planned" : "fixPlanned");
    await this.hold("waiting", round === "change" ? "waiting" : "fixWaiting");

    const pull = this.pull;
    await this.limited("approve", async () => {
      await this.d.forge.approvePull(pull, "The plan report shows what this change does.");
      await this.d.chant.approve({ pull, op: plan.op, gate: plan.gate, digest: plan.digest, approver: `forgejo@${FORGE_HOST}:${REVIEWER}` });
    });
    await this.write("approved");

    const merge = await this.limited("merge", () => this.d.forge.mergePull(pull));
    this.commit = merge;
    await this.write("merged");
    await this.write("applying");

    const applyKey = reportKey(pull, merge);
    const apply = await this.waitReport(applyKey, "pr-apply.json", "apply", (r) => r.stage === "apply" && ["applied", "failed", "refused"].includes(r.status));
    this.applyKey = applyKey;
    this.addReport("apply", pull, merge, applyKey);
    const wrong = round === "change" ? checkChangeApply(apply) : checkFixApply(apply);
    if (wrong) throw new Stall(apply.status === "refused" ? `${wrong} (refused: ${apply.refusal ?? apply.message ?? "no reason"})` : wrong);
  }

  /** Run `fn` and stall when it took longer than the step's limit. */
  private async limited<T>(limit: LimitName, fn: () => Promise<T>): Promise<T> {
    const start = this.d.clock.now();
    const out = await fn();
    if (this.d.clock.now() - start > this.limits[limit] * 1000) {
      throw new Stall(`the ${limit} step ran past its limit of ${this.limits[limit]}s`);
    }
    return out;
  }

  /** Poll the bucket for a stage's report until `done` holds of it, or stall past the limit. */
  private async waitReport(key: string, file: string, limit: LimitName, done: (r: PrReportView) => boolean): Promise<PrReportView> {
    const deadline = this.d.clock.now() + this.limits[limit] * 1000;
    const poll = (this.d.pollSeconds ?? 2) * 1000;
    const refresh = (this.d.refreshSeconds ?? 15) * 1000;
    for (;;) {
      const text = await this.d.bucket.get(KEYS.report(key, file));
      if (text) {
        try {
          const report = JSON.parse(text) as PrReportView;
          if (done(report)) return report;
        } catch {
          // A half-read object; the next look reads it whole.
        }
      }
      if (this.d.clock.now() >= deadline) {
        throw new Stall(`no ${file} at ${key} within ${this.limits[limit]}s`);
      }
      await this.d.clock.sleep(poll);
      if (this.current && this.d.clock.now() - this.lastWriteAt >= refresh) await this.rewrite();
    }
  }

  private addReport(stage: "plan" | "apply", pr: number, commit: string, key: string): void {
    this.reports.push({ stage, pr, commit, key });
  }

  /** Write a step whose next action is the driver's own, and hold it. */
  private async hold(step: DemoStepName, hold: HoldName): Promise<void> {
    const from = this.d.clock.now();
    const at = from + this.holds[hold] * 1000;
    await this.write(step, { next: { action: NEXT[step] ?? step, from: iso(from), at: iso(at) } });
    await this.d.clock.sleep(this.holds[hold] * 1000);
  }

  /** The step record for now. */
  private record(step: DemoStepName, extra: { label?: string; next?: StepRecord["next"] }): StepRecord {
    const round = this.round;
    const chapter = round === null ? null : chapterFor(round, step);
    const reports = {
      url: REPORT_URL,
      ...(this.planKey ? { plan: this.planKey } : {}),
      ...(this.applyKey ? { apply: this.applyKey } : {}),
    };
    const label =
      extra.label ?? (round === null ? BASE_LABEL : labelFor(round, step, { cycle: this.cycle, pull: this.pull, commit: this.commit }));
    return {
      $schema: STEP_SCHEMA,
      contract: 1,
      demo: DEMO,
      repo: REPO,
      cycle: this.cycle,
      scenario: SCENARIO,
      name: NAME,
      title: TITLE,
      step,
      label,
      chapter,
      started_at: iso(this.started),
      at: iso(this.d.clock.now()),
      ...(extra.next ? { next: extra.next } : {}),
      pull: this.pull,
      ...(this.commit ? { commit: this.commit } : {}),
      reports,
      cycle_reports: this.reports.map((r) => ({ ...r })),
      ...(this.about ? { about: { ...this.about } } : {}),
      highlight: round === null ? null : highlightFor(round, step),
    };
  }

  /** Validate a step and write it to step.json. An invalid step is a bug, so it throws. */
  private async write(step: DemoStepName, extra: { label?: string; next?: StepRecord["next"] } = {}): Promise<StepRecord> {
    const next = extra.next ?? { action: NEXT[step] ?? step, from: iso(this.d.clock.now()) };
    this.current = { step, label: extra.label, next };
    this.lastWriteAt = this.d.clock.now();
    const rec = this.record(step, { label: extra.label, next });
    await writeStep(this.d.bucket, rec);
    this.steps.push(rec);
    this.lastChapter = rec.chapter ?? null;
    this.lastStep = step;
    this.log(`cycle ${this.cycle}: ${step}: ${rec.label}`);
    return rec;
  }

  /** The current step again, as it was written but for `at`. */
  private async rewrite(): Promise<void> {
    const c = this.current!;
    this.lastWriteAt = this.d.clock.now();
    await writeStep(this.d.bucket, this.record(c.step, { label: c.label, next: c.next }));
  }

  /** The stalled step: the last step's chapter, pull and commit, no next. */
  private async writeStalled(after: string, reason: string): Promise<void> {
    const base = this.record("stalled", { label: stalledLabel(after, reason) });
    const rec: StepRecord = { ...base, chapter: this.lastChapter, highlight: null };
    delete rec.next;
    await writeStep(this.d.bucket, rec);
    this.steps.push(rec);
  }

  /**
   * Back to the base, out of band: close the open pull requests, force main to
   * the base commit, delete chant/lifecycle and the demo branches on the demo
   * repo, and apply the base again, so network's name goes back and
   * cluster-a's .fifo queue is deleted.
   */
  private async resetWork(): Promise<void> {
    await this.limited("reset", async () => {
      await resetToBase(this.d.forge, this.d.chant, this.d.baseSha);
    });
  }

  /** demo-cycle/v1 to cycles/<cycle>.json and cycles/latest.json, keeping the newest five. */
  private async publish(): Promise<DemoCycle> {
    if (this.steps.some((s) => s.step === "stalled")) throw new Error("a stalled cycle is never published");
    const doc: DemoCycle = {
      $schema: CYCLE_SCHEMA,
      contract: 1,
      demo: DEMO,
      repo: REPO,
      cycle: this.cycle,
      started: iso(this.started),
      ended: this.steps[this.steps.length - 1]!.at,
      steps: this.steps.map((s) => ({ ...s, at: s.at! })),
      reports: this.reports.map((r) => ({ ...r })),
    };
    const valid = validateDemoCycle(doc);
    if (!valid.ok) throw new Error(`cycle ${this.cycle} does not validate as demo-cycle/v1: ${valid.errors.join("; ")}`);
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    await this.d.bucket.put(KEYS.cycle(this.cycle), body, "application/json");
    await this.d.bucket.put(KEYS.latest, body, "application/json");
    await pruneCycles(this.d.bucket);
    return doc;
  }
}

/** Validate a step and put it at step.json. */
export async function writeStep(bucket: Bucket, rec: StepRecord): Promise<void> {
  const valid = validateDemoStep(rec);
  if (!valid.ok) throw new Error(`step ${rec.step} does not validate as demo-step/v1: ${valid.errors.join("; ")}`);
  await bucket.put(KEYS.step, `${JSON.stringify(rec, null, 2)}\n`, "application/json");
}

/** Delete every cycles/<n>.json but the newest five. */
export async function pruneCycles(bucket: Bucket): Promise<void> {
  const numbered = (await bucket.list(KEYS.cycles))
    .map((key) => ({ key, n: /\/(\d+)\.json$/.exec(key)?.[1] }))
    .filter((k): k is { key: string; n: string } => k.n !== undefined)
    .sort((a, b) => Number(b.n) - Number(a.n));
  for (const old of numbered.slice(CYCLES_KEPT)) await bucket.delete(old.key);
}

/** The branches a reset deletes on the demo repo: chant/lifecycle and the demo's own. */
export const isResetBranch = (name: string): boolean => name === "chant/lifecycle" || name.startsWith("demo/");

/** The forge repo and the stacks back to the base. */
export async function resetToBase(forge: Forge, chant: Chant, baseSha: string): Promise<void> {
  for (const n of await forge.openPulls()) await forge.closePull(n);
  await forge.forceMain(baseSha);
  for (const b of await forge.branches()) if (isResetBranch(b)) await forge.deleteBranch(b);
  await chant.applyBase();
}

/** The base step, written by up and by a reset outside a cycle. */
export async function writeBase(bucket: Bucket, clock: Clock, cycle: number, baseSha: string, label = BASE_LABEL): Promise<StepRecord> {
  const now = iso(clock.now());
  const rec: StepRecord = {
    $schema: STEP_SCHEMA,
    contract: 1,
    demo: DEMO,
    repo: REPO,
    cycle,
    scenario: SCENARIO,
    name: NAME,
    title: TITLE,
    step: "reset",
    label,
    chapter: null,
    started_at: now,
    at: now,
    next: { action: NEXT.reset!, from: now },
    pull: null,
    commit: baseSha,
    reports: { url: REPORT_URL },
    cycle_reports: [],
    highlight: null,
  };
  await writeStep(bucket, rec);
  return rec;
}
