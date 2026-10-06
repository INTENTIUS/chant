/**
 * A gate that asks a declared decision point (#3170), against a stub asker
 * and an in-memory gate ledger: the declaration's checks, the `gate.*`
 * inputs, an open question ending the run `waiting` with a pending fact that
 * cites it, an answer passing the gate with a resolution that cites the
 * record (once), an answer the gate does not pass on failing the step, and a
 * plain gate deciding as before. The end-to-end run through `chant workspace
 * points answer` is in `./gate-point.e2e.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { gate, Op, phase, activity } from "./builders";
import { memoryGateLedgerPort } from "./gate";
import { gatePointInputs, gatePointProblems, gateSubject, type GatePointFacts } from "./gate-point";
import { evaluatePointGate, type GatePointAsker, type GatePointQuestion, type GatePointRequest } from "./gate-point-run";
import { runOpLocally } from "./local-executor";
import { stepOutput } from "./step-output-ref";
import type { ActivityFn } from "./activity-registry";
import type { OpConfig } from "./types";

const PLAN = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const NOW = "2026-10-06T10:00:00.000Z";
const LATER = "2026-10-06T11:00:00.000Z";

/** A stub asker: the question's state comes from `answers`, by plan digest, and every request is kept. */
function stubAsker(answers: Map<string | null, Partial<GatePointQuestion>>): GatePointAsker & { asked: GatePointRequest[] } {
  const asked: GatePointRequest[] = [];
  return {
    asked,
    async ask(request) {
      asked.push(request);
      const id = `${request.point}-${(request.facts.planDigest ?? "none").slice(7, 19)}`;
      const given = answers.get(request.facts.planDigest) ?? {};
      return {
        id,
        point: request.point,
        path: `answers/${id}.md`,
        state: "escalated",
        answer: null,
        decider: "quorum",
        answeredBy: [],
        subject: request.subject,
        steward: null,
        ...given,
      };
    },
  };
}

const facts = (over: Partial<GatePointFacts> = {}): GatePointFacts => ({ component: "prod-apply", name: "apply", env: null, planDigest: PLAN, ...over });

describe("a gate's point declaration (#3170)", () => {
  test("gate() takes a point by name or as { name, inputs, pass }", () => {
    expect(gate("apply", { point: "prod-apply" }).point).toBe("prod-apply");
    expect(gate("apply", { point: { name: "prod-apply", pass: ["apply"] } }).point).toEqual({ name: "prod-apply", pass: ["apply"] });
  });

  test("gate() refuses a point beside an approval block, a bad name, and a gate.* input given by hand", () => {
    expect(() => gate("apply", { point: "prod-apply", approval: { quorum: { count: 2 } } })).toThrow(/give `approval` or `point`, not both/);
    expect(() => gate("apply", { point: "Prod Apply" })).toThrow(/decision point's name/);
    expect(() => gate("apply", { point: { name: "prod-apply", inputs: { "gate.planDigest": PLAN } } })).toThrow(/which the gate passes itself/);
    expect(gatePointProblems({ name: "prod-apply", pass: [] })).toEqual(["`point.pass` is a non-empty list of the answers that pass the gate"]);
    expect(gatePointProblems({ name: "prod-apply", quorum: 2 })).toEqual(["`point` takes name, inputs and pass, not quorum"]);
  });

  test("the gate passes the gate.* inputs the point declares, beside the authored ones", () => {
    expect(gatePointInputs("prod-apply", ["gate.component", "gate.planDigest", "record.size"], facts(), { "record.size": 3 })).toEqual({
      "record.size": 3,
      "gate.component": "prod-apply",
      "gate.planDigest": PLAN,
    });
    // gate.env is null without --env, so it is left out even when declared.
    expect(gatePointInputs("prod-apply", ["gate.env", "gate.planDigest"], facts())).toEqual({ "gate.planDigest": PLAN });
  });

  test("a plan-bound gate refuses a point that does not declare gate.planDigest", () => {
    expect(() => gatePointInputs("prod-apply", ["gate.component"], facts())).toThrow(/does not declare the input gate.planDigest/);
    // A gate that binds no plan needs no such input.
    expect(gatePointInputs("prod-apply", ["gate.component"], facts({ planDigest: null }))).toEqual({ "gate.component": "prod-apply" });
  });

  test("the answer record names the gate as gate:<op>/<gate>, with @<env> when the run names one", () => {
    expect(gateSubject("prod-apply", "apply")).toBe("gate:prod-apply/apply");
    expect(gateSubject("prod-apply", "apply", "prod")).toBe("gate:prod-apply/apply@prod");
  });
});

describe("evaluatePointGate (#3170)", () => {
  test("an open question records one pending fact that cites it, and a second run leaves it standing", async () => {
    const port = memoryGateLedgerPort();
    const asker = stubAsker(new Map());
    const input = { op: "prod-apply", gate: "apply", point: { name: "prod-apply" }, planDigest: PLAN, now: NOW };
    const first = await evaluatePointGate(port, asker, input);
    if (first.satisfied || !("waiting" in first)) throw new Error("expected the gate to wait");
    expect(first.recorded).toBe(true);
    expect(first.waiting).toMatchObject({ id: "prod-apply-aaaaaaaaaaaa", point: "prod-apply", state: "escalated" });
    expect(first.pending).toMatchObject({ op: "prod-apply", gate: "apply", planDigest: PLAN, answer: { point: "prod-apply", id: "prod-apply-aaaaaaaaaaaa", path: "answers/prod-apply-aaaaaaaaaaaa.md" } });
    expect(asker.asked[0]).toMatchObject({ point: "prod-apply", subject: "gate:prod-apply/apply", facts: { component: "prod-apply", name: "apply", planDigest: PLAN } });

    const second = await evaluatePointGate(port, asker, { ...input, now: LATER });
    if (second.satisfied || !("waiting" in second)) throw new Error("expected the gate to wait");
    expect(second.recorded).toBe(false);
    expect(port.appended).toHaveLength(1);
  });

  test("an answer it passes on writes one resolution citing the answer record, and a retry reuses it", async () => {
    const port = memoryGateLedgerPort();
    const asker = stubAsker(new Map([[PLAN, { state: "answered", answer: true, answeredBy: ["alice"] }]]));
    const input = { op: "prod-apply", gate: "apply", point: { name: "prod-apply" }, planDigest: PLAN, now: NOW };
    const first = await evaluatePointGate(port, asker, input);
    if (!first.satisfied) throw new Error("expected the gate to pass");
    expect(first.recorded).toBe(true);
    expect(first.resolution).toMatchObject({
      op: "prod-apply",
      gate: "apply",
      resolvedBy: "alice",
      planDigest: PLAN,
      approver: { kind: "human" },
      answer: { point: "prod-apply", id: "prod-apply-aaaaaaaaaaaa", path: "answers/prod-apply-aaaaaaaaaaaa.md", answer: true, decider: "quorum", answeredBy: ["alice"] },
    });
    const again = await evaluatePointGate(port, asker, { ...input, now: LATER });
    if (!again.satisfied) throw new Error("expected the gate to pass");
    expect(again.recorded).toBe(false);
    expect(port.resolved).toHaveLength(1);
  });

  test("an answer for one plan does not pass another: the new plan is a new question", async () => {
    const port = memoryGateLedgerPort();
    const asker = stubAsker(new Map([[PLAN, { state: "answered", answer: true, answeredBy: ["alice"] }]]));
    const passed = await evaluatePointGate(port, asker, { op: "prod-apply", gate: "apply", point: { name: "prod-apply" }, planDigest: PLAN, now: NOW });
    expect(passed.satisfied).toBe(true);
    const moved = await evaluatePointGate(port, asker, { op: "prod-apply", gate: "apply", point: { name: "prod-apply" }, planDigest: OTHER, now: LATER });
    if (moved.satisfied || !("waiting" in moved)) throw new Error("expected the gate to wait on the new plan's question");
    expect(moved.waiting.id).toBe("prod-apply-bbbbbbbbbbbb");
    expect(moved.pending.planDigest).toBe(OTHER);
  });

  test("a table's answer passes the gate, recorded as the decider's", async () => {
    const port = memoryGateLedgerPort();
    const asker = stubAsker(new Map([[PLAN, { state: "answered", answer: true, decider: "table" }]]));
    const check = await evaluatePointGate(port, asker, { op: "prod-apply", gate: "apply", point: { name: "prod-apply" }, planDigest: PLAN, now: NOW });
    if (!check.satisfied) throw new Error("expected the gate to pass");
    expect(check.resolution).toMatchObject({ resolvedBy: "table", approver: { kind: "agent" }, answer: { decider: "table", answer: true } });
  });

  test("an answer the gate does not pass on is refused, naming the record and how to ask again", async () => {
    const port = memoryGateLedgerPort();
    const asker = stubAsker(new Map([[PLAN, { state: "answered", answer: false, answeredBy: ["alice"] }]]));
    const check = await evaluatePointGate(port, asker, { op: "prod-apply", gate: "apply", point: { name: "prod-apply" }, planDigest: PLAN, now: NOW });
    if (check.satisfied || !("refused" in check)) throw new Error("expected a refusal");
    expect(check.refused).toContain("prod-apply-aaaaaaaaaaaa");
    expect(check.refused).toContain("chant workspace points retract prod-apply-aaaaaaaaaaaa");
    expect(port.resolved).toHaveLength(0);
  });

  test("pass names the answers a choice point passes on", async () => {
    const port = memoryGateLedgerPort();
    const asker = stubAsker(new Map([[PLAN, { state: "answered", answer: "apply", answeredBy: ["alice"] }]]));
    const check = await evaluatePointGate(port, asker, { op: "prod-apply", gate: "apply", point: { name: "prod-route", pass: ["apply"] }, planDigest: PLAN, now: NOW });
    expect(check.satisfied).toBe(true);
  });
});

describe("a run reaching a gate that asks a point (#3170)", () => {
  const applied: string[] = [];
  const activities = new Map<string, ActivityFn>([
    ["plan", async () => ({ planDigest: PLAN })],
    ["apply", async () => {
      applied.push("apply");
      return { ok: true };
    }],
  ]);
  const opWith = (gateStep: ReturnType<typeof gate>): OpConfig =>
    (Op({
      name: "prod-apply",
      overview: "Plan, gate and apply.",
      phases: [
        phase("Plan", [activity("plan", {}, { id: "plan" })]),
        phase("Approve", [gateStep]),
        phase("Apply", [activity("apply", {})]),
      ],
    }) as unknown as { props: OpConfig }).props;

  test("an open question ends the run waiting on it, and its answer lets the next run apply", async () => {
    applied.length = 0;
    const port = memoryGateLedgerPort();
    const answers = new Map<string | null, Partial<GatePointQuestion>>();
    const asker = stubAsker(answers);
    const config = opWith(gate("apply", { plan: stepOutput("plan", "planDigest"), point: "prod-apply" }));

    const first = await runOpLocally(config, activities, {}, undefined, { gates: port, points: asker, now: NOW });
    expect(first.status).toBe("waiting");
    expect(first.point).toMatchObject({ id: "prod-apply-aaaaaaaaaaaa", point: "prod-apply" });
    expect(first.records.find((r) => r.fn === "gate:apply")).toMatchObject({ status: "skipped", point: { id: "prod-apply-aaaaaaaaaaaa" } });
    expect(applied).toEqual([]);

    answers.set(PLAN, { state: "answered", answer: true, answeredBy: ["alice"] });
    const second = await runOpLocally(config, activities, {}, undefined, { gates: port, points: asker, now: LATER });
    expect(second.status).toBe("ok");
    expect(applied).toEqual(["apply"]);
    const step = second.records.find((r) => r.fn === "gate:apply");
    expect(step?.approval).toMatchObject({ gate: "apply", resolvedBy: "alice", via: "point", answer: { id: "prod-apply-aaaaaaaaaaaa", answer: true } });
    expect(port.resolved[0].answer?.id).toBe("prod-apply-aaaaaaaaaaaa");
  });

  test("a no fails the run at the gate and applies nothing", async () => {
    applied.length = 0;
    const port = memoryGateLedgerPort();
    const asker = stubAsker(new Map([[PLAN, { state: "answered", answer: false, answeredBy: ["alice"] }]]));
    const config = opWith(gate("apply", { plan: stepOutput("plan", "planDigest"), point: "prod-apply" }));
    const failed = await runOpLocally(config, activities, {}, undefined, { gates: port, points: asker, now: NOW }).then(
      () => {
        throw new Error("expected the run to fail");
      },
      (err: { result?: { status: string; records: Array<{ fn: string; status: string; error?: string }> } }) => err.result,
    );
    expect(failed?.status).toBe("fail");
    expect(failed?.records.find((r) => r.fn === "gate:apply")).toMatchObject({ status: "fail" });
    expect(applied).toEqual([]);
  });

  test("a plain gate still records a pending fact and ends gated, and never asks a point", async () => {
    applied.length = 0;
    const port = memoryGateLedgerPort();
    const asker = stubAsker(new Map());
    const config = opWith(gate("apply", { plan: stepOutput("plan", "planDigest") }));
    const result = await runOpLocally(config, activities, {}, undefined, { gates: port, points: asker, now: NOW });
    expect(result.status).toBe("gated");
    expect(result.gate).toMatchObject({ gate: "apply", planDigest: PLAN });
    expect(result.gate?.answer).toBeUndefined();
    expect(asker.asked).toHaveLength(0);
    expect(applied).toEqual([]);
  });
});
