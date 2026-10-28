/**
 * The fan-out demo's cycle (#4091), in process: fakes stand in for the forge,
 * the bucket and chant, and a fake pipeline writes chant's reports where the
 * real one uploads them. Nothing here starts a container or opens a socket.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { reportKey } from "../../../packages/core/src/pr-report-url.js";
import { validateDemoCycle, validateDemoStep, type DemoCycle } from "./schemas/index.js";
import {
  CYCLES_KEPT,
  DemoCycleRun,
  KEYS,
  checkChangeApply,
  checkFixApply,
  componentStatuses,
  lastCycle,
  pruneCycles,
  writeBase,
  type CycleDeps,
  type StepRecord,
} from "./lib/cycle.js";
import { overlayFiles } from "./lib/overlays.js";
import { lintScenario } from "../../../packages/core/src/e2e-harness/scenario.js";
import type { Scenario } from "../../../packages/core/src/e2e-harness/schemas/index.js";
import type { ApproveInput, Bucket, Chant, Clock, Forge } from "./lib/ports.js";
import { FIXED, HELD, HIGHLIGHTS, HIGHLIGHT_LIMITS, TITLE, WAVES, WENT, chapterFor, highlightFor, labelFor } from "./steps.js";

const EXAMPLE = join(import.meta.dirname, "..");
const BASE_SHA = "b".repeat(40);
const ALL = WAVES.flat();

class FakeClock implements Clock {
  t = Date.parse("2026-10-18T10:00:00Z");
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

/** An in-memory bucket. An object put with `visibleAt` is not there until the clock reaches it. */
class FakeBucket implements Bucket {
  readonly objects = new Map<string, { body: string; visibleAt: number }>();
  /** Every body written to step.json, in order. */
  readonly stepWrites: StepRecord[] = [];
  constructor(private readonly clock: Clock) {}
  async get(key: string): Promise<string | null> {
    const o = this.objects.get(key);
    return o && o.visibleAt <= this.clock.now() ? o.body : null;
  }
  async put(key: string, body: string): Promise<void> {
    this.objects.set(key, { body, visibleAt: 0 });
    if (key === KEYS.step) this.stepWrites.push(JSON.parse(body) as StepRecord);
  }
  later(key: string, body: string, visibleAt: number): void {
    this.objects.set(key, { body, visibleAt });
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const sha = (s: string): string => createHash("sha1").update(s).digest("hex");

/** The stacks as the fake pipeline and chant leave them. */
type Estate = Record<string, string>;
const baseEstate = (): Estate => ({ network: "fan-out-estate network", "cluster-a": "no events queue" });

/** How the fake pipeline behaves. */
interface PipelineMode {
  /** Seconds after the push or merge that a report shows up. */
  delay: number;
  /** The change's apply never reports. */
  noApply?: boolean;
  /** Edit the change's pr-apply.json members before it is written. */
  editChangeApply?: (members: Member[]) => void;
}

interface Member {
  member: string;
  component: string;
  planDigest: string | null;
  status: string;
  counts: { create: number; update: number; replace: number; delete: number };
}

const member = (component: string, status: string): Member => ({
  member: component,
  component,
  planDigest: `sha256:${"0".repeat(64)}`,
  status,
  counts: { create: 0, update: 1, replace: 0, delete: 0 },
});

function report(stage: "plan" | "apply", pr: number, head: string, status: string, waves: string[][], members: Member[]) {
  return JSON.stringify({
    $schema: "https://intentius.io/chant/schemas/workspace/pr-report/v1/pr-report.schema.json",
    contract: 1,
    stage,
    pr,
    env: "demo",
    base: BASE_SHA,
    head,
    op: `pr-${pr}`,
    gate: "pr-apply",
    digest: `jcs1-sha256:${sha(`${pr}${head}`).padEnd(64, "0")}`,
    status,
    approval: { status: stage === "plan" ? "pending" : "approved" },
    selection: { changed: [], dependents: [], unclaimed: [], indeterminate: [], waves },
    members,
    changeSet: {},
  });
}

/** Forgejo and its pipeline, in memory. */
class FakeForge implements Forge {
  main = BASE_SHA;
  branchSet = new Set<string>(["main"]);
  pulls = new Map<number, { branch: string; head: string; open: boolean; approved: boolean }>();
  next = 40;
  estate: Estate = baseEstate();
  constructor(
    private readonly bucket: FakeBucket,
    private readonly clock: FakeClock,
    private readonly mode: PipelineMode,
  ) {}

  private reportAt(pr: number, commit: string, file: string, body: string): void {
    this.bucket.later(KEYS.report(reportKey(pr, commit), file), body, this.clock.now() + this.mode.delay * 1000);
  }

  pushed = new Map<string, string>();
  async pushBranch(branch: string, files: Record<string, string>): Promise<string> {
    this.branchSet.add(branch);
    const head = sha(`${branch}:${JSON.stringify(files)}`);
    this.pushed.set(branch, head);
    return head;
  }
  async openPull(branch: string): Promise<number> {
    const n = this.next++;
    const head = this.pushed.get(branch)!;
    this.pulls.set(n, { branch, head, open: true, approved: false });
    const fix = branch.includes("fix");
    const waves = fix ? [["cluster-a"], [...HELD]] : WAVES.map((w) => [...w]);
    this.reportAt(n, head, "pr-plan.json", report("plan", n, head, "planned", waves, waves.flat().map((c) => member(c, "planned"))));
    return n;
  }
  async approvePull(pull: number): Promise<void> {
    this.pulls.get(pull)!.approved = true;
  }
  async mergePull(pull: number): Promise<string> {
    const p = this.pulls.get(pull)!;
    if (!p.approved) throw new Error("not approved");
    p.open = false;
    const merge = sha(`merge:${pull}`);
    this.main = merge;
    const fix = p.branch.includes("fix");
    if (fix) {
      this.estate["cluster-a"] = "events queue .fifo";
      this.reportAt(pull, merge, "pr-apply.json", report("apply", pull, merge, "applied", [["cluster-a"], [...HELD]], FIXED.map((c) => member(c, "applied"))));
    } else if (!this.mode.noApply) {
      this.estate.network = `fan-out-estate network, cycle ${p.branch.split("-").pop()}`;
      const members = [...WENT.map((c) => member(c, "applied")), member("cluster-a", "failed"), ...HELD.map((c) => member(c, "blocked"))];
      this.mode.editChangeApply?.(members);
      this.reportAt(pull, merge, "pr-apply.json", report("apply", pull, merge, "failed", WAVES.map((w) => [...w]), members));
    }
    return merge;
  }
  async openPulls(): Promise<number[]> {
    return [...this.pulls].filter(([, p]) => p.open).map(([n]) => n);
  }
  async closePull(pull: number): Promise<void> {
    this.pulls.get(pull)!.open = false;
  }
  async forceMain(s: string): Promise<void> {
    this.main = s;
  }
  async branches(): Promise<string[]> {
    return [...this.branchSet];
  }
  async deleteBranch(name: string): Promise<void> {
    this.branchSet.delete(name);
  }
}

class FakeChant implements Chant {
  approvals: ApproveInput[] = [];
  bases = 0;
  constructor(private readonly forge: FakeForge) {}
  async approve(input: ApproveInput): Promise<void> {
    this.approvals.push(input);
    this.forge.branchSet.add("chant/lifecycle");
  }
  async applyBase(): Promise<void> {
    this.bases++;
    this.forge.estate = baseEstate();
  }
}

function setup(mode: PipelineMode = { delay: 20 }, extra: Partial<CycleDeps> = {}) {
  const clock = new FakeClock();
  const bucket = new FakeBucket(clock);
  const forge = new FakeForge(bucket, clock, mode);
  const chant = new FakeChant(forge);
  const deps: CycleDeps = { forge, bucket, chant, clock, overlays: overlayFiles, baseSha: BASE_SHA, refreshSeconds: 5, ...extra };
  return { clock, bucket, forge, chant, deps };
}

const ORDER = [
  "pull-request", "planned", "waiting", "approved", "merged", "applying", "failed",
  "pull-request", "planned", "waiting", "approved", "merged", "applying", "applied", "reset",
];

describe("one cycle of the fan-out demo", () => {
  test("plays all four chapters in order and publishes the cycle", async () => {
    const { bucket, deps } = setup();
    const run = new DemoCycleRun(1, deps);
    const outcome = await run.run();
    expect(outcome.status).toBe("applied");
    expect(run.steps.map((s) => s.step)).toEqual(ORDER);
    expect(run.steps.map((s) => s.chapter?.n)).toEqual([1, 1, 1, 1, 1, 1, 2, 3, 3, 3, 3, 3, 3, 4, 4]);
    expect(run.steps.every((s) => s.title === TITLE && s.chapter?.of === 4)).toBe(true);
    expect(run.steps[6]!.label).toContain("SQS refuses a FIFO queue whose name lacks .fifo");
    // The change's card for chapters 1 and 2, the fix's after.
    expect(run.steps[0]!.about?.changes).toContain("edits the shared network");
    expect(run.steps[7]!.about?.changes).toContain("ends in .fifo");

    const latest = JSON.parse((await bucket.get(KEYS.latest))!) as DemoCycle;
    expect(validateDemoCycle(latest).ok).toBe(true);
    expect(latest.cycle).toBe(1);
    expect(latest.steps.map((s) => s.step)).toEqual(ORDER);
    expect(await bucket.get(KEYS.cycle(1))).toBe(await bucket.get(KEYS.latest));
    expect(await lastCycle(bucket)).toBe(1);
  });

  test("every write to step.json validates as demo-step/v1, and so does the base", async () => {
    const { bucket, clock, deps } = setup();
    await writeBase(bucket, clock, 0, BASE_SHA);
    await new DemoCycleRun(1, deps).run();
    expect(bucket.stepWrites.length).toBeGreaterThan(ORDER.length);
    for (const w of bucket.stepWrites) {
      const v = validateDemoStep(w);
      expect(v.ok ? [] : v.errors).toEqual([]);
    }
    expect(bucket.stepWrites[0]!.chapter).toBeNull();
  });

  test("cycle_reports grows in run order: the change's plan and apply, then the fix's", async () => {
    const { deps } = setup();
    const run = new DemoCycleRun(1, deps);
    await run.run();
    const last = run.steps[run.steps.length - 1]!.cycle_reports!;
    expect(last.map((r) => `${r.stage}:${r.pr}`)).toEqual(["plan:40", "apply:40", "plan:41", "apply:41"]);
    for (const r of last) expect(r.key).toBe(reportKey(r.pr, r.commit));
    // Each step's list is the one before it, maybe with more on the end.
    for (let i = 1; i < run.steps.length; i++) {
      const before = run.steps[i - 1]!.cycle_reports!;
      const now = run.steps[i]!.cycle_reports!;
      expect(now.slice(0, before.length)).toEqual(before);
    }
    // The plan's key is named from the planned step, the apply's from the failed step.
    expect(run.steps[1]!.reports?.plan).toBe(last[0]!.key);
    expect(run.steps[6]!.reports?.apply).toBe(last[1]!.key);
    expect(run.steps[6]!.commit).toBe(last[1]!.commit);
  });

  test("the reviewer approves the digest pr-plan.json names, as the forge principal", async () => {
    const { chant, deps } = setup();
    await new DemoCycleRun(1, deps).run();
    expect(chant.approvals.map((a) => [a.op, a.gate, a.approver])).toEqual([
      ["pr-40", "pr-apply", "forgejo@forgejo:3000:reviewer"],
      ["pr-41", "pr-apply", "forgejo@forgejo:3000:reviewer"],
    ]);
    expect(chant.approvals[0]!.digest).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
  });

  test("the reset puts the forge repo and the stacks back to the base", async () => {
    const { forge, chant, deps } = setup();
    await new DemoCycleRun(3, deps).run();
    expect(forge.main).toBe(BASE_SHA);
    expect(await forge.openPulls()).toEqual([]);
    expect([...forge.branchSet]).toEqual(["main"]);
    expect(chant.bases).toBe(1);
    expect(forge.estate).toEqual(baseEstate());
  });
});

describe("the failure is read from pr-apply.json's members[].status", () => {
  const members = () => [...WENT.map((c) => member(c, "applied")), member("cluster-a", "failed"), ...HELD.map((c) => member(c, "blocked"))];

  test("the story's failure passes, and any other shape is named", () => {
    expect(checkChangeApply({ status: "failed", members: members() })).toBeNull();
    expect(checkChangeApply({ status: "applied", members: members() })).toMatch(/ended applied/);
    const m = members();
    m.find((x) => x.component === "app-03")!.status = "applied";
    expect(checkChangeApply({ status: "failed", members: m })).toBe("app-03 was not blocked by cluster-a's failure (it is applied)");
    const n = members();
    n.find((x) => x.component === "cluster-b")!.status = "failed";
    expect(checkChangeApply({ status: "failed", members: n })).toMatch(/cluster-b did not apply/);
    expect(checkFixApply({ status: "applied", members: FIXED.map((c) => member(c, "applied")) })).toBeNull();
    expect(checkFixApply({ status: "applied", members: [...FIXED, "network"].map((c) => member(c, "applied")) })).toMatch(/beyond the seven/);
  });

  test("a component with two members counts as failed when one failed", () => {
    const s = componentStatuses({ members: [{ ...member("x", "applied"), member: "x/a" }, { ...member("x", "failed"), member: "x/b" }] });
    expect(s.get("x")).toBe("failed");
  });

  test("an apply whose members differ from the story stalls the cycle", async () => {
    const { bucket, deps } = setup({ delay: 20, editChangeApply: (m) => (m.find((x) => x.component === "app-05")!.status = "applied") });
    const outcome = await new DemoCycleRun(1, deps).run();
    expect(outcome).toMatchObject({ status: "stalled", after: "applying" });
    expect(outcome.status === "stalled" && outcome.reason).toContain("app-05 was not blocked");
    expect(await bucket.get(KEYS.latest)).toBeNull();
  });
});

describe("a step past its time limit", () => {
  test("writes stalled, keeps the chapter before it, resets, and is never published", async () => {
    const { bucket, forge, chant, deps } = setup({ delay: 20, noApply: true }, { limits: { apply: 120 } });
    const run = new DemoCycleRun(2, deps);
    const outcome = await run.run();
    expect(outcome).toMatchObject({ status: "stalled", cycle: 2, after: "applying" });
    const stalled = bucket.stepWrites.find((w) => w.step === "stalled")!;
    expect(stalled.chapter?.n).toBe(1);
    expect(stalled.label).toMatch(/^Stalled after applying: no pr-apply.json at 40\/[0-9a-f]{40} within 120s\./);
    expect(stalled.next).toBeUndefined();
    expect(validateDemoStep(stalled).ok).toBe(true);
    // The reset ran and wrote the base, and no cycle was published.
    expect(bucket.stepWrites[bucket.stepWrites.length - 1]).toMatchObject({ step: "reset", chapter: null });
    expect(forge.main).toBe(BASE_SHA);
    expect(chant.bases).toBe(1);
    expect(await bucket.list(KEYS.cycles)).toEqual([]);
  });

  test("a stall before the first step has no chapter", async () => {
    const { bucket, deps } = setup();
    deps.forge.pushBranch = async () => {
      throw new Error("the forge is down");
    };
    const outcome = await new DemoCycleRun(1, deps).run();
    expect(outcome).toMatchObject({ status: "stalled", after: "the start" });
    expect(bucket.stepWrites[0]).toMatchObject({ step: "stalled", chapter: null });
  });

  test("a stalled cycle does not replace the last full one", async () => {
    const { bucket, deps } = setup();
    await new DemoCycleRun(1, deps).run();
    const before = await bucket.get(KEYS.latest);
    const s = setup({ delay: 20, noApply: true }, { limits: { apply: 60 } });
    s.bucket.objects.set(KEYS.latest, { body: before!, visibleAt: 0 });
    await new DemoCycleRun(2, s.deps).run();
    expect(await s.bucket.get(KEYS.latest)).toBe(before);
    expect(await s.bucket.get(KEYS.cycle(2))).toBeNull();
  });
});

describe("highlights", () => {
  test("the three beats carry their highlight and every other write has null", async () => {
    const { bucket, deps } = setup();
    await new DemoCycleRun(1, deps).run();
    let round: "change" | "fix" = "change";
    for (const w of bucket.stepWrites) {
      expect(Object.keys(w)).toContain("highlight");
      if (w.chapter?.n === 3 || w.chapter?.n === 4) round = "fix";
      const want =
        round === "change" && w.step === "planned" ? HIGHLIGHTS.plan
        : round === "change" && w.step === "failed" ? HIGHLIGHTS.failed
        : round === "fix" && w.step === "applying" ? HIGHLIGHTS.fix
        : null;
      expect(w.highlight).toEqual(want);
    }
    const lit = bucket.stepWrites.filter((w) => w.highlight).map((w) => `${w.chapter?.n}:${w.step}`);
    expect([...new Set(lit)]).toEqual(["1:planned", "2:failed", "3:applying"]);
  });

  test("a step written again while the driver waits carries the same highlight, label and next", async () => {
    const { bucket, deps } = setup({ delay: 30 });
    await new DemoCycleRun(1, deps).run();
    const fixApplying = bucket.stepWrites.filter((w) => w.step === "applying" && w.chapter?.n === 3);
    expect(fixApplying.length).toBeGreaterThan(1);
    for (const w of fixApplying) {
      expect(w.highlight).toEqual(fixApplying[0]!.highlight);
      expect(w.label).toBe(fixApplying[0]!.label);
      expect(w.next).toEqual(fixApplying[0]!.next);
    }
    expect(new Set(fixApplying.map((w) => w.at)).size).toBe(fixApplying.length);
  });

  test("titles are at most 60 characters and bodies at most 300", () => {
    for (const h of Object.values(HIGHLIGHTS)) {
      expect(h.title.length).toBeLessThanOrEqual(HIGHLIGHT_LIMITS.title);
      expect(h.body.length).toBeLessThanOrEqual(HIGHLIGHT_LIMITS.body);
      expect(h.body).not.toMatch(/\u2014|quietly|seamless|robust|leverage/);
    }
    expect(highlightFor(null, "reset")).toBeNull();
    expect(highlightFor("fix", "planned")).toBeNull();
  });
});

describe("steps.ts", () => {
  test("names the chapters as the story tells them", () => {
    expect(chapterFor("change", "applying")?.short).toBe("The change goes out");
    expect(chapterFor("change", "failed")?.headline).toBe("cluster-a breaks. Only its 6 apps stop; the other 8 stacks ship anyway");
    expect(chapterFor("fix", "pull-request")?.n).toBe(3);
    expect(chapterFor("fix", "reset")?.short).toBe("Done");
    expect(chapterFor(null, "reset")).toBeNull();
    expect(labelFor("change", "merged", { cycle: 1, pull: 7, commit: "abcdef0123" })).toBe(
      "Pull request 7 is merged into main (the branch the pipeline applies) at abcdef01, and the pipeline starts.",
    );
  });
});

describe("the overlays", () => {
  const base = (p: string) => readFileSync(join(EXAMPLE, p), "utf8").split("\n");
  const diff = (a: string[], b: string[]) => b.filter((l) => !a.includes(l));

  test("the change renames network's topic for the cycle and adds a FIFO queue without .fifo", () => {
    const files = overlayFiles("change", 12);
    expect(Object.keys(files).sort()).toEqual(["src/cluster-a/resources.ts", "src/network/resources.ts"]);
    expect(diff(base("src/network/resources.ts"), files["src/network/resources.ts"]!.split("\n"))).toEqual([
      '  DisplayName: "fan-out-estate network, cycle 12",',
    ]);
    const queue = files["src/cluster-a/resources.ts"]!;
    expect(queue).toContain('QueueName: "fan-out-estate-cluster-a-events",');
    expect(queue).toContain("FifoQueue: true,");
  });

  test("the fix gives the queue its .fifo, and changes nothing else", () => {
    const change = overlayFiles("change", 1)["src/cluster-a/resources.ts"]!.split("\n");
    const fix = overlayFiles("fix", 1);
    expect(Object.keys(fix)).toEqual(["src/cluster-a/resources.ts"]);
    expect(diff(change, fix["src/cluster-a/resources.ts"]!.split("\n"))).toEqual(['  QueueName: "fan-out-estate-cluster-a-events.fifo",']);
  });
});

describe("cycles/", () => {
  test("keeps the newest five numbered cycles and latest.json", async () => {
    const bucket = new FakeBucket(new FakeClock());
    for (const n of [1, 2, 3, 4, 5, 6, 7, 10]) await bucket.put(KEYS.cycle(n), "{}");
    await bucket.put(KEYS.latest, "{}");
    await pruneCycles(bucket);
    expect((await bucket.list(KEYS.cycles)).sort()).toEqual(
      [KEYS.cycle(10), KEYS.cycle(4), KEYS.cycle(5), KEYS.cycle(6), KEYS.cycle(7), KEYS.latest].sort(),
    );
    expect(CYCLES_KEPT).toBe(5);
  });
});

describe("the demo's claim on the e2e harness (chant#4587)", () => {
  const scenario = JSON.parse(readFileSync(join(import.meta.dirname, "scenario.json"), "utf8")) as Scenario;

  test("scenario.json lints clean, with a claim id and a BREAK arm", () => {
    expect(lintScenario(scenario)).toEqual([]);
    expect(scenario.claim).toBe("fan-out/failure-blocks-only-dependents");
    expect(scenario.break.env.BREAK).toBe("1");
  });

  test("names the overlays the cycle uses, and the components the story names", () => {
    for (const step of scenario.steps) if ("overlay" in step) expect(Object.keys(overlayFiles(step.overlay as "change" | "fix", 0)).length).toBeGreaterThan(0);
    expect(Object.keys(overlayFiles(scenario.break.overlay as "fix", 0))).toEqual(["src/cluster-a/resources.ts"]);
    const changeApply = scenario.steps.find((s) => s.id === "change-apply")!.expect![0] as { report: { components: Record<string, string> } };
    expect(Object.keys(changeApply.report.components).sort()).toEqual([...WAVES.flat()].sort());
    for (const m of HELD) expect(changeApply.report.components[m]).toBe("blocked");
    for (const m of WENT) expect(changeApply.report.components[m]).toBe("applied");
    const fixApply = scenario.steps.find((s) => s.id === "fix-apply")!.expect![0] as { report: { components: Record<string, string> } };
    expect(Object.keys(fixApply.report.components).sort()).toEqual([...FIXED].sort());
  });
});
