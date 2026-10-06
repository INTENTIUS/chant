/**
 * #3170's Done when, end to end: an infra apply Op's gate (`ApplyOp` with
 * `gate.point`) is answered through `chant workspace points answer`, the run
 * proceeds on that answer, and the answer record and the gate ledger entry
 * reference each other.
 *
 * The workspace is real (a git repository with the reference workspace's
 * answer kind and a points file), the point is asked through the decide
 * activity's path, and the answer goes through the command's own handler,
 * `runWorkspacePoints`. The gate ledger is the in-memory port, and the build,
 * plan and apply activities are stubs: the plan's digest is what the gate
 * binds.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanScratch, workspace } from "../workspace/__fixtures__/decide-workspace";
import { runWorkspacePoints } from "../workspace/points-cli";
import { workspacePoints } from "../workspace/points-cli";
import type { CommandContext } from "../cli/registry";
import { ApplyOp } from "./composites/apply-op";
import { memoryGateLedgerPort } from "./gate";
import { runOpLocally } from "./local-executor";
import type { ActivityFn } from "./activity-registry";
import type { OpConfig } from "./types";

const PLAN_A = `jcs1-sha256:${"1".repeat(64)}`;
const PLAN_B = `jcs1-sha256:${"2".repeat(64)}`;

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

let root: string;
let plan = PLAN_A;
const applied: string[] = [];
const activities = new Map<string, ActivityFn>([
  ["chantBuild", async () => ({ ok: true })],
  ["lifecycleDiff", async () => ({ planDigest: plan, drifted: true })],
  ["nativeApply", async () => {
    applied.push(plan);
    return { ok: true };
  }],
]);

const config = (): OpConfig =>
  (ApplyOp({ name: "prod-apply", env: "prod", target: "kubectl", gate: { gate: "approve-apply", point: "prod-apply" } }).op as unknown as { props: OpConfig }).props;

/** `chant workspace points answer <id> --answer <value> --by <name>`, through the command's handler, in the workspace. Returns the document it prints. */
async function pointsAnswer(id: string, answer: string, by: string): Promise<Record<string, unknown>> {
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const was = process.cwd();
  process.chdir(root);
  try {
    const ctx = { args: { extraPositional: "answer", extraPositional2: id, answer, bys: [by] }, plugins: [], serializers: [] } as unknown as CommandContext;
    const code = await runWorkspacePoints(ctx);
    expect(code).toBe(0);
  } finally {
    process.chdir(was);
    log.mockRestore();
  }
  return JSON.parse(printed.join("\n")) as Record<string, unknown>;
}

beforeAll(() => {
  root = workspace(POINTS);
});

afterAll(cleanScratch);

describe("an infra apply Op's gate answered through chant workspace points answer (#3170)", () => {
  test("the run waits on the point, proceeds on its answer, and the answer record and the ledger entry cite each other", async () => {
    const port = memoryGateLedgerPort();
    const op = config();

    // 1. The run reaches the gate: the point is asked, the question is open
    //    for people, the run ends waiting on it, and nothing is applied.
    const first = await runOpLocally(op, activities, {}, undefined, { gates: port, cwd: root, now: "2026-10-06T10:00:00.000Z" });
    expect(first.status).toBe("waiting");
    expect(applied).toEqual([]);
    const question = first.point!;
    expect(question).toMatchObject({ point: "prod-apply", state: "escalated", subject: "gate:prod-apply/approve-apply" });

    // The pending fact on the gate ledger names the question.
    expect(port.appended).toHaveLength(1);
    expect(port.appended[0]).toMatchObject({ op: "prod-apply", gate: "approve-apply", planDigest: PLAN_A, answer: { point: "prod-apply", id: question.id, path: question.path } });

    // The question is open in the workspace, asked with the gate's facts.
    const open = await workspacePoints({ cwd: root, open: true });
    if ("error" in open) throw new Error(open.error.message);
    expect(open.questions.find((q) => q.id === question.id)).toMatchObject({
      state: "escalated",
      subject: "gate:prod-apply/approve-apply",
      inputs: { "gate.component": "prod-apply", "gate.planDigest": PLAN_A },
    });

    // 2. A person answers it through the command.
    const doc = await pointsAnswer(question.id, "yes", "alice");
    expect(doc).toMatchObject({ verb: "answer", id: question.id, written: true, question: { state: "answered", answer: true, answeredBy: ["alice"] } });

    // 3. The next run proceeds on the answer and applies the plan.
    const second = await runOpLocally(op, activities, {}, undefined, { gates: port, cwd: root, now: "2026-10-06T10:05:00.000Z" });
    expect(second.status).toBe("ok");
    expect(applied).toEqual([PLAN_A]);
    const gateStep = second.records.find((r) => r.fn === "gate:approve-apply");
    expect(gateStep?.approval).toMatchObject({ gate: "approve-apply", resolvedBy: "alice", via: "point", answer: { id: question.id, path: question.path, answer: true } });

    // 4. The ledger entry cites the answer record...
    expect(port.resolved).toHaveLength(1);
    const resolution = port.resolved[0];
    expect(resolution).toMatchObject({
      op: "prod-apply",
      gate: "approve-apply",
      resolvedBy: "alice",
      planDigest: PLAN_A,
      answer: { point: "prod-apply", id: question.id, path: question.path, answer: true, decider: "quorum", answeredBy: ["alice"] },
    });
    // ...and the answer record names the gate and the plan the entry is for.
    const text = readFileSync(join(root, resolution.answer!.path), "utf-8");
    expect(text).toContain(`id: "${question.id}"`);
    expect(text).toContain("gate:prod-apply/approve-apply");
    expect(text).toContain(PLAN_A);
    const answered = await workspacePoints({ cwd: root });
    if ("error" in answered) throw new Error(answered.error.message);
    expect(answered.questions.find((q) => q.id === resolution.answer!.id)).toMatchObject({
      state: "answered",
      subject: `gate:${resolution.op}/${resolution.gate}`,
      inputs: { "gate.component": resolution.op, "gate.planDigest": resolution.planDigest },
      answeredBy: ["alice"],
    });
  });

  test("a retry of the answered plan writes no second resolution, and a new plan is a new question", async () => {
    const port = memoryGateLedgerPort();
    const op = config();
    plan = PLAN_A;
    applied.length = 0;

    // The answer from the first test stands for PLAN_A: this ledger has no
    // pending fact yet, and the run passes at once, citing the same record.
    const retry = await runOpLocally(op, activities, {}, undefined, { gates: port, cwd: root, now: "2026-10-06T11:00:00.000Z" });
    expect(retry.status).toBe("ok");
    expect(port.resolved).toHaveLength(1);
    const again = await runOpLocally(op, activities, {}, undefined, { gates: port, cwd: root, now: "2026-10-06T11:01:00.000Z" });
    expect(again.status).toBe("ok");
    expect(port.resolved).toHaveLength(1);

    // Another plan asks another question, and waits on it.
    plan = PLAN_B;
    const moved = await runOpLocally(op, activities, {}, undefined, { gates: port, cwd: root, now: "2026-10-06T11:02:00.000Z" });
    expect(moved.status).toBe("waiting");
    expect(moved.point?.id).not.toBe(port.resolved[0].answer?.id);
    expect(applied).toEqual([PLAN_A, PLAN_A]);
  });
});
