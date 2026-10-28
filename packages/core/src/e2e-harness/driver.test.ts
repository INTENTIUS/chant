/**
 * The harness's driver (chant#4587) running a scenario in process, with
 * fakes for the forge, the report bucket, chant, the ledger and the clock. A
 * fake pipeline writes chant's reports where the jobs would: pr-plan.json at
 * the head when a pull request opens, pr-apply.json at the merge commit when
 * it merges. Nothing here starts a container or opens a socket.
 */
import { describe, expect, test } from "vitest";
import type { OpRunRecord } from "../op/runtime";
import { runArm, runClaim, verdictsOf, type DriverPorts } from "./driver";
import type { ApproveInput, Bucket, Clock, ForgeIssue, PullForge } from "./ports";
import { reportObjectKey } from "./reports";
import { lintScenario } from "./scenario";
import { E2E_SCENARIO_SCHEMA, type Scenario } from "./schemas/index";

const PREFIX = "shop/reports";

/** The fan-out story as a scenario: the change fails cluster-a, the fix applies the seven. */
function fanOut(over: Partial<Scenario> = {}): Scenario {
  return {
    $schema: E2E_SCENARIO_SCHEMA,
    contract: 1,
    id: "fan-out",
    product: "chant",
    claim: "fan-out/failure-blocks-dependents",
    tree: { base: "../..", overlays: "overlays" },
    env: "demo",
    reportUrl: `s3://chant-demo/${PREFIX}`,
    steps: [
      { id: "change", do: "open", branch: "demo/change", overlay: "change", title: "The change" },
      { id: "change-plan", do: "plan", pull: "change", expect: [{ report: { status: "planned" } }] },
      { id: "change-approve", do: "approve", pull: "change" },
      { id: "change-merge", do: "merge", pull: "change" },
      {
        id: "change-apply",
        do: "apply",
        merge: "change-merge",
        expect: [{ report: { status: "failed", components: { "cluster-a": "failed", "app-01": "blocked", "cluster-b": "applied" } } }],
      },
    ],
    break: { env: { BREAK: "1" }, note: "cluster-a's queue gets a valid name, so nothing fails" },
    ...over,
  };
}

/** Time that moves only when the driver sleeps. */
function fakeClock(start = Date.parse("2026-10-28T10:00:00Z")): Clock & { t: number } {
  const c = {
    t: start,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms;
    },
  };
  return c;
}

function fakeBucket(): Bucket & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    get: async (k) => objects.get(k) ?? null,
    put: async (k, b) => void objects.set(k, b),
    list: async (p) => [...objects.keys()].filter((k) => k.startsWith(p)),
    delete: async (k) => void objects.delete(k),
  };
}

interface World {
  ports: DriverPorts;
  bucket: ReturnType<typeof fakeBucket>;
  clock: ReturnType<typeof fakeClock>;
  approvals: ApproveInput[];
  opened: Array<{ branch: string; files: Record<string, string> }>;
  comments: Map<number, string[]>;
  ledger: OpRunRecord[];
  resets: number;
  armEnv: Record<string, string>[];
  log: string[];
}

/**
 * A forge and a pipeline that plans and applies on its own. `broken` is what
 * BREAK=1 does to the pipeline here: cluster-a applies cleanly, so the
 * failure the claim is about never happens. `silent` stops the pipeline from
 * writing an apply report at all.
 */
function world(o: { silent?: boolean; breakDoesNothing?: boolean } = {}): World {
  const bucket = fakeBucket();
  const clock = fakeClock();
  const approvals: ApproveInput[] = [];
  const opened: World["opened"] = [];
  const comments = new Map<number, string[]>();
  const ledger: OpRunRecord[] = [];
  const log: string[] = [];
  let broken = false;
  let next = 1;
  const heads = new Map<number, string>();
  const sha = (n: number, kind: string) => `${kind}${String(n).padStart(40 - kind.length, "0")}`;
  const w = { resets: 0, armEnv: [] as Record<string, string>[] };

  const forge: PullForge & { comments(pull: number): Promise<string[]>; issues(): Promise<ForgeIssue[]> } = {
    async pushBranch(branch, files) {
      opened.push({ branch, files });
      return sha(opened.length, "a");
    },
    async openPull(branch) {
      const pull = next++;
      const head = sha(opened.findIndex((x) => x.branch === branch) + 1, "a");
      heads.set(pull, head);
      // The pipeline's plan job.
      await bucket.put(
        reportObjectKey(PREFIX, pull, head, "plan"),
        JSON.stringify({ stage: "plan", pr: pull, head, op: `pr-${pull}`, gate: "pr-apply", digest: `jcs1-sha256:${pull}`, status: "planned", selection: { waves: [] }, members: [] }),
        "application/json",
      );
      comments.set(pull, [`plan for #${pull}: 15 stacks in 3 waves`]);
      return pull;
    },
    async approvePull() {},
    async mergePull(pull) {
      const commit = sha(pull, "b");
      if (!o.silent) {
        const clusterA = broken ? "applied" : "failed";
        const app01 = broken ? "applied" : "blocked";
        await bucket.put(
          reportObjectKey(PREFIX, pull, commit, "apply"),
          JSON.stringify({
            stage: "apply",
            pr: pull,
            head: commit,
            op: `pr-${pull}`,
            gate: "pr-apply",
            digest: "",
            status: broken ? "applied" : "failed",
            selection: { waves: [] },
            members: [
              { member: "cluster-a", component: "cluster-a", status: clusterA },
              { member: "app-01", component: "app-01", status: app01 },
              { member: "cluster-b", component: "cluster-b", status: "applied" },
            ],
          }),
          "application/json",
        );
        ledger.push({
          version: 1,
          id: `run-${pull}`,
          op: "pr-apply",
          env: "demo",
          started: new Date(clock.now()).toISOString(),
          ended: new Date(clock.now()).toISOString(),
          status: broken ? "ok" : "fail",
          labels: {},
          outcomes: {},
          phases: [],
        });
      }
      return commit;
    },
    openPulls: async () => [],
    closePull: async () => {},
    forceMain: async () => {},
    branches: async () => [],
    deleteBranch: async () => {},
    comments: async (pull) => comments.get(pull) ?? [],
    issues: async () => [{ number: 9, title: "drift: shop-dev", body: "", open: true }],
  };

  const ports: DriverPorts = {
    forge,
    bucket,
    clock,
    chant: { approve: async (i) => void approvals.push(i) },
    overlay: (name) => ({ [`src/${name}.ts`]: `export const overlay = "${name}";\n` }),
    ledger: { runs: async (env, op) => ledger.filter((r) => r.env === env && r.op === op) },
    reset: async () => {
      w.resets++;
    },
    arm: async (arm, env) => {
      w.armEnv.push(env);
      broken = arm === "break" && env.BREAK === "1" && !o.breakDoesNothing;
    },
    log: (line) => log.push(line),
  };
  return { ports, bucket, clock, approvals, opened, comments, ledger, log, get resets() { return w.resets; }, get armEnv() { return w.armEnv; } } as World;
}

const OPTS = { approver: "forgejo@forgejo:3000:reviewer", pollMs: 1000 };

describe("the e2e harness's driver", () => {
  test("the fixture scenario lints clean", () => {
    expect(lintScenario(fanOut())).toEqual([]);
  });

  test("a plain run whose outcomes all hold passes, and approves the plan's digest as the reviewer", async () => {
    const w = world();
    const run = await runArm(fanOut(), "plain", w.ports, OPTS);
    expect(run.outcome).toBe("held");
    expect(run.steps.map((s) => s.id)).toEqual(["change", "change-plan", "change-approve", "change-merge", "change-apply"]);
    expect(w.approvals).toEqual([{ pull: 1, op: "pr-1", gate: "pr-apply", digest: "jcs1-sha256:1", approver: "forgejo@forgejo:3000:reviewer" }]);
    expect(w.opened[0]).toEqual({ branch: "demo/change", files: { "src/change.ts": 'export const overlay = "change";\n' } });
  });

  test("the BREAK run is caught when an outcome stops holding, on its own branch", async () => {
    const w = world();
    const claim = await runClaim(fanOut(), w.ports, OPTS);
    expect(claim.plain.outcome).toBe("held");
    expect(claim.break.outcome).toBe("broke");
    expect(claim.break.reason).toMatch(/change-apply: the apply report ended applied, not failed/);
    expect(claim.break.steps.at(-1)?.stopped?.outcome).toBe("broke");
    expect(claim.verdicts).toEqual({ plain: "pass", break: "caught" });
    expect(w.opened.map((o) => o.branch)).toEqual(["demo/change", "demo/change-break"]);
    expect(w.resets).toBe(2);
    expect(w.armEnv).toEqual([{}, { BREAK: "1" }]);
  });

  test("a BREAK run that changes nothing is missed", async () => {
    const w = world({ breakDoesNothing: true });
    const claim = await runClaim(fanOut(), w.ports, OPTS);
    expect(claim.verdicts).toEqual({ plain: "pass", break: "missed" });
  });

  test("a report that never comes stalls the run past its limit, and a stall is neither verdict", async () => {
    const w = world({ silent: true });
    const run = await runArm(fanOut({ limits: { apply: 30 } }), "plain", w.ports, OPTS);
    expect(run.outcome).toBe("stalled");
    expect(run.reason).toMatch(/change-apply: no pr-apply.json at 1\/b0+1 within 30s/);
    expect(run.steps.at(-1)).toMatchObject({ id: "change-apply", stopped: { outcome: "stalled" } });
    expect(verdictsOf(run, run)).toEqual({ plain: "fail", break: "stalled" });
  });

  test("the break overlay goes over every pull request of the BREAK run", async () => {
    const w = world();
    await runArm(fanOut({ break: { env: { BREAK: "1" }, overlay: "break" } }), "break", w.ports, OPTS);
    expect(w.opened[0]!.files).toEqual({
      "src/change.ts": 'export const overlay = "change";\n',
      "src/break.ts": 'export const overlay = "break";\n',
    });
  });

  test("open-concurrent opens its pull request beside the open before it", async () => {
    const w = world();
    const s = fanOut({
      steps: [
        { id: "a", do: "open", branch: "a", overlay: "change", title: "A" },
        { id: "b", do: "open-concurrent", branch: "b", overlay: "fix", title: "B" },
        { id: "a-plan", do: "plan", pull: "a", expect: [{ report: { status: "planned" } }] },
        { id: "b-plan", do: "plan", pull: "b", expect: [{ comment: "plan for #2" }] },
      ],
    });
    expect(lintScenario(s)).toEqual([]);
    const run = await runArm(s, "plain", w.ports, OPTS);
    expect(run.outcome).toBe("held");
    expect(run.steps.map((x) => [x.id, x.pull])).toEqual([
      ["a", 1],
      ["b", 2],
      ["a-plan", 1],
      ["b-plan", 2],
    ]);
  });

  test("ledger, comment and issue outcomes read the ledger and the forge", async () => {
    const w = world();
    const s = fanOut();
    s.steps[4]!.expect!.push({ ledger: { op: "pr-apply", status: "fail", count: 1 } }, { comment: "15 stacks" }, { issue: { title: "drift", open: true } });
    expect((await runArm(s, "plain", w.ports, OPTS)).outcome).toBe("held");

    const wrong = fanOut();
    wrong.steps[4]!.expect = [{ ledger: { op: "pr-apply", status: "ok" } }];
    const run = await runArm(wrong, "plain", world().ports, OPTS);
    expect(run.outcome).toBe("broke");
    expect(run.reason).toMatch(/no pr-apply run ok on the ledger/);
  });

  test("out-of-band and kill-job steps go through their ports, and stall without them", async () => {
    const w = world();
    const ran: string[][] = [];
    const killed: Array<string | undefined> = [];
    const s = fanOut({
      steps: [
        { id: "drift", do: "out-of-band", command: ["aws", "sqs", "tag-queue"], expect: [{ exit: 0 }] },
        { id: "kill", do: "kill-job", match: "pr-apply" },
      ],
    });
    const run = await runArm(s, "plain", { ...w.ports, outOfBand: { run: async (c) => (ran.push(c), 0) }, jobs: { kill: async (m) => (killed.push(m), true) } }, OPTS);
    expect(run.outcome).toBe("held");
    expect(ran).toEqual([["aws", "sqs", "tag-queue"]]);
    expect(killed).toEqual(["pr-apply"]);

    const bare = await runArm(s, "plain", w.ports, OPTS);
    expect(bare.outcome).toBe("stalled");
    expect(bare.reason).toMatch(/drift: an out-of-band step needs the out-of-band port/);

    const none = await runArm(s, "plain", { ...w.ports, outOfBand: { run: async () => 0 }, jobs: { kill: async () => false } }, OPTS);
    expect(none.reason).toMatch(/kill: no running job matching pr-apply to kill/);
  });

  test("a forge error stalls the run at its step", async () => {
    const w = world();
    const run = await runArm(fanOut(), "plain", { ...w.ports, forge: { ...w.ports.forge, mergePull: async () => Promise.reject(new Error("Forgejo answered 500")) } }, OPTS);
    expect(run.outcome).toBe("stalled");
    expect(run.reason).toBe("change-merge: Forgejo answered 500");
  });
});
