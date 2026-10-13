/**
 * #3835: an answered decision point resumes the job waiting on it. A gate
 * that asks a point writes its resolution only when the run asks again, so
 * `chant run resume` used to see no approval and leave the job stopped. Now a
 * pending fact that cites a question is resumable once the question has an
 * answer the gate passes on, and `points answer --resume` resumes right after
 * the answer.
 *
 * Clones of one bare remote stand for the CI job's checkout, the person's
 * clone the answer comes from, the scheduled resume job's checkout and the
 * resumed job's. The gate ledger is the real one on `chant/lifecycle`, so the
 * pending fact, the question and its answer all travel through the remote.
 * The forge is a stubbed `fetch` that answers as GitHub does for a failed run.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanScratch, workspace } from "../workspace/__fixtures__/decide-workspace";
import { runWorkspacePoints } from "../workspace/points-cli";
import { runResumeCommand } from "../cli/handlers/gate-resume";
import type { CommandContext } from "../cli/registry";
import { readGateLedger } from "../lifecycle/gate-ledger";
import { pointGateResumable } from "../point-decision";
import { ApplyOp } from "./composites/apply-op";
import { gitGateLedgerPort } from "./gate";
import type { GatePoint } from "./gate-point";
import { runOpLocally } from "./local-executor";
import type { ActivityFn } from "./activity-registry";
import type { OpConfig } from "./types";

const PLAN = `jcs1-sha256:${"6".repeat(64)}`;

const POINTS = {
  points: {
    "prod-apply": {
      title: "Apply this plan to prod",
      question: { type: "noul", instructions: "Should this plan be applied to prod?", criteria: { true: "Apply it.", false: "Do not apply it." } },
      inputs: { "gate.component": "the Op the gate belongs to", "gate.planDigest": "the plan the gate binds" },
      deciders: [{ kind: "quorum", count: 1 }],
    },
  },
};

const GITHUB = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", GITHUB_API_URL: "https://api.github.test" };

const applied: string[] = [];
const activities = new Map<string, ActivityFn>([
  ["chantBuild", async () => ({ ok: true })],
  ["lifecycleDiff", async () => ({ planDigest: PLAN, drifted: true })],
  ["nativeApply", async () => {
    applied.push(PLAN);
    return { ok: true };
  }],
]);

const config = (name: string, point: GatePoint): OpConfig =>
  (ApplyOp({ name, env: "prod", target: "kubectl", gate: { gate: "approve-apply", point } }).op as unknown as { props: OpConfig }).props;

let home: string;
let remote: string;
let n = 0;

function clone(): string {
  const dir = join(home, `clone-${++n}`);
  execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" });
  return dir;
}

/** A wave's run in `cwd`, on the real gate ledger. */
const run = (op: OpConfig, cwd: string) => runOpLocally(op, activities, {}, undefined, { gates: gitGateLedgerPort({ cwd }), cwd, now: new Date().toISOString() });

/** Run a command handler in `cwd`; returns what it printed on standard output, parsed, and its exit code. */
async function inDir<T>(cwd: string, handler: (ctx: CommandContext) => Promise<number>, args: Record<string, unknown>): Promise<{ code: number; doc: T }> {
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const was = process.cwd();
  process.chdir(cwd);
  try {
    const code = await handler({ args, plugins: [], serializers: [] } as unknown as CommandContext);
    return { code, doc: JSON.parse(printed.join("\n")) as T };
  } finally {
    process.chdir(was);
    log.mockRestore();
    err.mockRestore();
  }
}

/** The forge: a GitHub run that ended in failure (the job exited 3 at the gate). Records each call. */
let calls: string[];
function stubForge(): void {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: { method: string }) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    const body = init.method === "GET" ? JSON.stringify({ status: "completed", conclusion: "failure", run_attempt: 1 }) : "";
    return { ok: true, status: 200, text: async () => body };
  });
}

type Report = { op: string; gate: string; status: string; message: string; approvedBy?: string };

/** The job waits at the gate in CI; returns the question's id. */
async function waitInCi(op: OpConfig): Promise<string> {
  for (const [k, v] of Object.entries(GITHUB)) vi.stubEnv(k, v);
  const first = await run(op, clone());
  expect(first.status).toBe("waiting");
  for (const k of Object.keys(GITHUB)) vi.stubEnv(k, "");
  return first.point!.id;
}

const answer = (id: string, value: string, extra: Record<string, unknown> = {}) =>
  inDir<Record<string, unknown>>(clone(), runWorkspacePoints, { extraPositional: "answer", extraPositional2: id, answer: value, bys: ["alice"], ...extra });

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "chant-gate-point-resume-")));
  const root = workspace(POINTS);
  remote = join(home, "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", root, remote], { stdio: "ignore" });
});

beforeEach(() => {
  vi.stubEnv("CI", "");
  vi.stubEnv("GITHUB_TOKEN", "t");
  stubForge();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(() => {
  cleanScratch();
  rmSync(home, { recursive: true, force: true });
});

describe("an answered decision point resumes the wave waiting on it (#3835)", () => {
  test("the wave waits on its point; the point is answered; chant run resume resumes it, and the resumed run passes", async () => {
    const op = config("resume-apply", { name: "prod-apply", store: "ledger" });
    const id = await waitInCi(op);

    // Before the answer, nothing is resumed.
    const before = await inDir<{ reports: Report[] }>(clone(), runResumeCommand, { op: "resume-apply", json: true });
    expect(before.doc.reports).toEqual([expect.objectContaining({ gate: "approve-apply", status: "not-approved", message: expect.stringContaining("not answered yet") })]);
    expect(calls).toEqual([]);

    expect((await answer(id, "yes")).doc).toMatchObject({ written: true, question: { state: "answered", answer: true } });

    // The scheduled resume job, in its own checkout.
    const resumed = await inDir<{ reports: Report[] }>(clone(), runResumeCommand, { op: "resume-apply", json: true });
    expect(resumed.code).toBe(0);
    expect(resumed.doc.reports).toEqual([expect.objectContaining({ gate: "approve-apply", status: "resumed", approvedBy: "alice" })]);
    expect(calls).toEqual(["GET /repos/acme/infra/actions/runs/42", "POST /repos/acme/infra/actions/runs/42/rerun-failed-jobs"]);

    // The resumed job asks again, finds the answer, writes the resolution that cites it, and applies.
    const job = clone();
    const next = await run(op, job);
    expect(next.status).toBe("ok");
    expect(applied).toContain(PLAN);
    const ledger = await readGateLedger("resume-apply", { cwd: job });
    expect(ledger.resolutions).toEqual([expect.objectContaining({ gate: "approve-apply", resolvedBy: "alice", answer: expect.objectContaining({ id, answer: true }) })]);
  }, 120_000);

  test("an answer that does not pass the gate resumes nothing", async () => {
    const op = config("refuse-apply", { name: "prod-apply", store: "ledger" });
    const id = await waitInCi(op);
    await answer(id, "no");

    const resumed = await inDir<{ reports: Report[] }>(clone(), runResumeCommand, { op: "refuse-apply", json: true });
    expect(resumed.code).toBe(0);
    expect(resumed.doc.reports).toEqual([expect.objectContaining({ status: "not-approved", message: expect.stringContaining("passes only on true") })]);
    expect(calls).toEqual([]);
  }, 120_000);

  test("a gate's own pass list is on the pending fact: an answer it names resumes, others don't", async () => {
    const op = config("pass-apply", { name: "prod-apply", store: "ledger", pass: [false] });
    const id = await waitInCi(op);
    const { pending } = await gitGateLedgerPort({ cwd: clone() }).read("pass-apply");
    expect(pending[0]!.answer).toMatchObject({ id, pass: [false] });
    expect(pending[0]!.resume).toMatchObject({ forge: "github", run: "42" });

    const answered = { id, state: "answered" as const, answeredBy: ["alice"], answeredOn: null };
    expect(pointGateResumable(pending[0]!, { ...answered, answer: false })).toMatchObject({ resumable: true, answeredBy: "alice" });
    expect(pointGateResumable(pending[0]!, { ...answered, answer: true })).toMatchObject({ resumable: false, why: "refused" });
    expect(pointGateResumable(pending[0]!, { ...answered, state: "escalated", answer: null })).toMatchObject({ resumable: false, why: "open" });
    expect(pointGateResumable(pending[0]!, undefined)).toMatchObject({ resumable: false, why: "unknown" });
  }, 120_000);

  test("points answer --resume resumes the job waiting at the gate the question names", async () => {
    const op = config("answer-resume-apply", { name: "prod-apply", store: "ledger" });
    const id = await waitInCi(op);

    const answered = await answer(id, "yes", { resumeRun: true });
    expect(answered.code).toBe(0);
    expect(answered.doc).toMatchObject({ written: true, question: { state: "answered", subject: "gate:answer-resume-apply/approve-apply" } });
    expect(calls).toEqual(["GET /repos/acme/infra/actions/runs/42", "POST /repos/acme/infra/actions/runs/42/rerun-failed-jobs"]);
  }, 120_000);
});
