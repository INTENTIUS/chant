/**
 * #3816: a tool built into one file decides a gate that asks a decision point
 * with `@intentius/chant/point-decision`, asking through the chant bin
 * (`chantGatePointAsker`) and recording through its own gate ledger port.
 * The question is open until a person answers it with `chant workspace points
 * answer`; then the same call records the resolution that cites the answer,
 * once per answer and plan. With `store: "ledger"` the question is held on
 * `chant/lifecycle`, not in the working tree (#3815).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanScratch, workspace } from "./workspace/__fixtures__/decide-workspace";
import { defaultChantCommand } from "./workspace/conformance";
import { memoryGateLedgerPort } from "./op/gate";
import { chantGatePointAsker, evaluatePointGate, type PointGateCheck } from "./point-decision";

const PLAN = `jcs1-sha256:${"5".repeat(64)}`;

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

const command = defaultChantCommand();
let root: string;

const chant = (...args: string[]): Record<string, unknown> => {
  let out: string;
  try {
    out = execFileSync(command[0], [...command.slice(1), ...args], { cwd: root, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  return JSON.parse(out) as Record<string, unknown>;
};

const answersInTree = (): string[] => (existsSync(join(root, "answers")) ? readdirSync(join(root, "answers")).filter((f) => f.endsWith(".md")) : []);

beforeAll(() => {
  root = workspace(POINTS);
  vi.stubEnv("CI", "");
});

afterAll(() => {
  vi.unstubAllEnvs();
  cleanScratch();
});

describe("a gate-point decision through the chant bin (#3816)", () => {
  test("waits on the open question, then passes on a person's answer, once per answer and plan", async () => {
    const port = memoryGateLedgerPort();
    const asker = chantGatePointAsker({ command, cwd: root });
    const input = { op: "tf-apply", gate: "approve-apply", point: { name: "prod-apply" }, planDigest: PLAN, now: "2026-10-11T13:00:00.000Z" };

    const first = await evaluatePointGate(port, asker, input);
    expect(first).toMatchObject({ satisfied: false, recorded: true, waiting: { point: "prod-apply", state: "escalated", subject: "gate:tf-apply/approve-apply" } });
    const waiting = first as Extract<PointGateCheck, { waiting: unknown }>;
    expect(port.appended).toEqual([expect.objectContaining({ op: "tf-apply", gate: "approve-apply", planDigest: PLAN, answer: { point: "prod-apply", id: waiting.waiting.id, path: waiting.waiting.path } })]);

    // Asked again while open, the standing pending fact is reused.
    expect(await evaluatePointGate(port, asker, input)).toMatchObject({ satisfied: false, recorded: false });

    expect(chant("workspace", "points", "answer", waiting.waiting.id, "--answer", "yes", "--by", "alice")).toMatchObject({ written: true, question: { state: "answered" } });

    const passed = await evaluatePointGate(port, asker, input);
    expect(passed).toMatchObject({ satisfied: true, recorded: true, resolution: { resolvedBy: "alice", planDigest: PLAN, answer: { id: waiting.waiting.id, answer: true, decider: "quorum", answeredBy: ["alice"] } } });
    expect(await evaluatePointGate(port, asker, input)).toMatchObject({ satisfied: true, recorded: false });
    expect(port.resolved).toHaveLength(1);
  }, 120_000);

  test("a point with store ledger holds the question on chant/lifecycle, and an answer it does not pass on refuses", async () => {
    const port = memoryGateLedgerPort();
    const asker = chantGatePointAsker({ command, cwd: root });
    const before = answersInTree();
    const input = { op: "ledger-apply", gate: "approve-apply", point: { name: "prod-apply", store: "ledger" as const }, planDigest: PLAN };

    const first = (await evaluatePointGate(port, asker, input)) as Extract<PointGateCheck, { waiting: unknown }>;
    expect(first.waiting.state).toBe("escalated");
    expect(answersInTree()).toEqual(before);

    chant("workspace", "points", "answer", first.waiting.id, "--answer", "no", "--by", "alice");
    const refused = await evaluatePointGate(port, asker, input);
    expect(refused).toMatchObject({ satisfied: false, answer: { id: first.waiting.id, answer: false } });
    expect("refused" in refused && refused.refused).toContain("passes only on true");
  }, 120_000);
});
