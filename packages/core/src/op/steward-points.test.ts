/**
 * Decision points reached in a steward's turn (#2749): the model call goes
 * through the steward's brokered capability, an open question stops the run
 * as `waiting` and stays open in the workspace for a person, the steward's
 * turn never answers it, and the local steward resumes the Op on the first
 * round after a person answers.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, git, REPO, repo } from "../workspace/__fixtures__/contract-repo";
import statusSchema from "../workspace/status.schema.json";
import { answerPoint } from "../workspace/decide";
import { workspacePoints } from "../workspace/points-cli";
import type { WireAnswer } from "../workspace/points";
import { readMemberStewards } from "../workspace/status-stewards";
import { readRunLedger } from "../lifecycle/run-ledger";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import { runOpLocally } from "./local-executor";
import { formatRoundLine, runOperatorRound } from "./operator";
import { declareSteward } from "./steward";
import { askPointInRun, isPointWait, PointWait, type BrokeredModelAsk } from "./steward-points";
import { enterStewardTurn, resetStewardTurn, STEWARD_ENV } from "./steward-turn";
import type { OpConfig } from "./types";

const REF = join(REPO, "reference-workspace");
const PROFILES: Record<string, ActivityProfile> = {};
const on = "2026-09-25";

const points = {
  points: {
    "ship-now": {
      title: "Ship this release now",
      question: { type: "noul", instructions: "Is the release ready to ship?", criteria: { true: "Ship it.", false: "Hold it." } },
      inputs: { release: "the release, as status lists it" },
      deciders: [
        { kind: "table", rows: [{ when: { release: "hotfix" }, answer: true }] },
        { kind: "model", backend: "systemone", model: "jev-1.13.0", threshold: 0.8 },
        { kind: "quorum", count: 1 },
      ],
    },
  },
};

const confident: WireAnswer = { type: "noul", noul: 0.97 };

let root: string;

beforeAll(() => {
  root = repo(
    {
      "chant.workspace.json": JSON.stringify(
        { name: "studio", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "a plain Node server" }], records: [{ kind: "answers/answer.kind.mjs" }] },
        null,
        2,
      ),
      "app/server.mjs": "export const port = 8080;\n",
      "decisions/points.json": JSON.stringify(points, null, 2),
      ".chant/trust.json": JSON.stringify({ schema: 1, roles: { agent: ["bot"] } }),
    },
    false,
  );
  cpSync(join(REF, "answers", "answer.kind.mjs"), join(root, "answers", "answer.kind.mjs"));
  cpSync(join(REF, "answers", "answer.schema.json"), join(root, "answers", "answer.schema.json"));
  // The run ledger and leases are written with git plumbing, which needs an identity.
  git(root, "config", "user.name", "Steward Test");
  git(root, "config", "user.email", "steward@example.com");
  commitAll(root, "c0");
});

afterEach(() => resetStewardTurn());
afterAll(cleanScratch);

/** A brokered model call that records what it was asked through. */
function brokered(answer: WireAnswer, calls: { capability: string }[]): BrokeredModelAsk {
  return async (req, via) => {
    calls.push({ capability: via.capability });
    return { model: req.model, answer };
  };
}

async function waitOf(p: Promise<unknown>): Promise<PointWait> {
  try {
    await p;
  } catch (err) {
    if (isPointWait(err)) return err;
    throw err;
  }
  throw new Error("expected the ask to wait");
}

describe("askPointInRun (#2749)", () => {
  test("an answered question returns its answer, outside any steward", async () => {
    const got = await askPointInRun({ cwd: root, point: "ship-now", inputs: { release: "hotfix" }, on });
    expect(got.answer).toBe(true);
    expect(got.question).toMatchObject({ state: "answered", askedBy: null });
  });

  test("in a steward's turn the model call goes through the steward's brokered capability, and a proposal waits for a person", async () => {
    enterStewardTurn({ steward: "box-steward", capabilities: ["inference"], vault: null, run: "run-1" });
    const calls: { capability: string }[] = [];
    const wait = await waitOf(askPointInRun({ cwd: root, point: "ship-now", inputs: { release: "r-1" }, subject: "r-1", ask: brokered(confident, calls), on }));
    expect(calls).toEqual([{ capability: "inference" }]);
    expect(wait.question).toMatchObject({ point: "ship-now", state: "proposed", subject: "r-1", steward: "box-steward" });
    const text = readFileSync(join(root, wait.question.path), "utf-8");
    expect(text).toContain('harness: "chant-steward"');
    expect(text).toContain('name: "box-steward"');
    expect(text).toContain('id: "run-1"');
    // The question is open in the read contract, naming who waits on it.
    const doc = await workspacePoints({ cwd: root, open: true });
    if (!("questions" in doc)) throw new Error(doc.error.message);
    expect(doc.questions.find((q) => q.id === wait.question.id)).toMatchObject({ open: true, state: "proposed", askedBy: { steward: "box-steward", run: "run-1" } });
  });

  test("a steward that doesn't name the capability makes no model call, and the question goes to people", async () => {
    enterStewardTurn({ steward: "box-steward", capabilities: ["fountain"], vault: null });
    const calls: { capability: string }[] = [];
    const wait = await waitOf(askPointInRun({ cwd: root, point: "ship-now", inputs: { release: "r-2" }, ask: brokered(confident, calls), on }));
    expect(calls).toEqual([]);
    expect(wait.question.state).toBe("escalated");
    const text = readFileSync(join(root, wait.question.path), "utf-8");
    expect(text).toMatch(/does not name the brokered capability inference \(it names fountain\)/);
  });

  test("a steward holding a vault makes no model call either", async () => {
    enterStewardTurn({ steward: "vault-steward", capabilities: [], vault: "creds" });
    const calls: { capability: string }[] = [];
    const wait = await waitOf(askPointInRun({ cwd: root, point: "ship-now", inputs: { release: "r-3" }, ask: brokered(confident, calls), on }));
    expect(calls).toEqual([]);
    expect(readFileSync(join(root, wait.question.path), "utf-8")).toMatch(/holds the vault creds/);
  });
});

describe("a steward never answers a question (#2749)", () => {
  test("points answer is refused inside a steward's turn, and in a process it started", async () => {
    enterStewardTurn({ steward: "box-steward", capabilities: ["inference"], vault: null });
    const wait = await waitOf(askPointInRun({ cwd: root, point: "ship-now", inputs: { release: "r-4" }, on }));
    const doc = await answerPoint({ cwd: root, id: wait.question.id, answer: "yes", by: ["alice"], on });
    expect("error" in doc && doc.error.code).toBe("answer-in-steward-turn");

    resetStewardTurn();
    process.env[STEWARD_ENV] = "box-steward";
    const child = await answerPoint({ cwd: root, id: wait.question.id, answer: "yes", by: ["alice"], on });
    expect("error" in child && child.error.code).toBe("answer-in-steward-turn");
  });

  test("the steward that asked never counts toward the quorum", async () => {
    enterStewardTurn({ steward: "box-steward", capabilities: [], vault: null });
    const wait = await waitOf(askPointInRun({ cwd: root, point: "ship-now", inputs: { release: "r-5" }, on }));
    resetStewardTurn();
    const doc = await answerPoint({ cwd: root, id: wait.question.id, answer: "yes", by: ["Box-Steward", "bot"], on });
    if (!("error" in doc)) throw new Error("expected a refusal");
    expect(doc.error.code).toBe("quorum-not-met");
    expect(doc.error.message).toMatch(/Box-Steward, who is the steward that asked/);
    expect(doc.error.message).toMatch(/bot, who holds the agent role/);
  });
});

function shipOp(name: string, release: string, cron?: string): OpConfig {
  return {
    name,
    overview: `${name} fixture`,
    phases: [
      { name: "Decide", steps: [{ kind: "activity", fn: "askShip", args: { release } }] },
      { name: "Ship", steps: [{ kind: "activity", fn: "ship", args: {} }] },
    ],
    onFailure: [{ name: "Undo", steps: [{ kind: "activity", fn: "undo", args: {} }] }],
    ...(cron ? { schedule: { cron, overlap: "skip" as const } } : {}),
  };
}

function shipActivities(log: string[]): Map<string, ActivityFn> {
  return new Map<string, ActivityFn>([
    ["askShip", async (args) => (await askPointInRun({ cwd: root, point: "ship-now", inputs: { release: args.release }, on })).answer],
    ["ship", async () => { log.push("ship"); return { shipped: true }; }],
    ["undo", async () => { log.push("undo"); return {}; }],
  ]);
}

describe("an Op waiting on a decision point (#2749)", () => {
  test("stops as waiting, like a gate: no later phase, no compensation, and the ledger names the question", async () => {
    const log: string[] = [];
    const result = await runOpLocally(shipOp("ship-once", "r-6"), shipActivities(log), PROFILES, undefined, { ledger: { cwd: root } });
    expect(result.status).toBe("waiting");
    expect(log).toEqual([]);
    expect(result.records.map((r) => [r.fn, r.status])).toEqual([["askShip", "skipped"], ["ship", "skipped"]]);
    expect(result.point).toMatchObject({ point: "ship-now", state: "escalated", steward: null });
    const newest = (await readRunLedger("local", "ship-once", { cwd: root })).records.at(-1)!;
    expect(newest).toMatchObject({ status: "waiting", point: { id: result.point!.id, point: "ship-now", state: "escalated" } });
    expect(newest.steward).toBeUndefined();
    expect(newest.phases[0].steps[0]).toMatchObject({ fn: "askShip", status: "skipped", point: { id: result.point!.id } });
  });

  test("a local steward records the wait, lists it in status, leaves it while open, and resumes once a person answers", async () => {
    const config = shipOp("box-ship", "r-7", "0 0 1 1 *");
    const steward = declareSteward({ name: "box-steward", ops: [config], capabilities: ["inference"] });
    const log: string[] = [];
    const scheduleState = new Map<string, Date>();
    // Cron minutes are local time, so the rounds are too.
    const round = (minute: number) =>
      runOperatorRound({ cwd: root, steward, activities: shipActivities(log), profiles: PROFILES, holder: "box", now: () => new Date(2027, 0, 1, 0, minute, 10), scheduleState });

    // The cron fires: the Op asks, nobody has answered, the run waits.
    const first = await round(0);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "ticked", op: "box-ship" });
    const ticked = first[0] as Extract<(typeof first)[number], { kind: "ticked" }>;
    expect(ticked.result.status).toBe("waiting");
    const question = ticked.result.point!.id;
    expect(formatRoundLine(first[0])).toContain(`status=waiting point="${question}"`);
    const newest = (await readRunLedger("local", "box-ship", { cwd: root })).records.at(-1)!;
    expect(newest).toMatchObject({ status: "waiting", steward: "box-steward", point: { id: question } });

    // workspace status lists what the steward waits on, beside its Ops.
    mkdirSync(join(root, "ops"), { recursive: true });
    writeFileSync(join(root, "chant.config.json"), "{}\n");
    writeFileSync(join(root, "ops", "steward.op.ts"), `export const steward = ${JSON.stringify(steward)};\n`);
    const status = await readMemberStewards(root, "local", "2027-01-01T00:01:00Z");
    expect(status.reasons).toEqual([]);
    const entry = status.stewards.find((s) => s.name === "box-steward")!;
    // The entry keeps status.schema.json's steward shape (#2731, #2749).
    const stewardShape = contract({ $schema: statusSchema.$schema, $id: "urn:test:status-steward", $defs: statusSchema.$defs, $ref: "#/$defs/steward" });
    stewardShape.expectValid(entry);
    expect(entry.ops[0].lastRun).toMatchObject({ status: "waiting", point: { id: question, point: "ship-now", state: "escalated" } });
    expect(entry.waiting).toEqual([
      { op: "box-ship", run: newest.id, id: question, point: "ship-now", state: "escalated", path: newest.point!.path, subject: null, since: newest.point!.since },
    ]);

    // Still open: the steward does not run it, and says what it waits on.
    const second = await round(5);
    expect(second).toEqual([{ kind: "waiting-on-point", op: "box-ship", env: "local", point: "ship-now", question, state: "escalated" }]);
    expect(formatRoundLine(second[0])).toBe(`operator: box-ship@local waiting=1(point:${question}:escalated)`);

    // A person answers, through hud or at a shell; the next round resumes the Op.
    const answered = await answerPoint({ cwd: root, id: question, answer: "yes", by: ["alice"], on });
    expect("error" in answered).toBe(false);
    const third = await round(10);
    expect(third[0]).toMatchObject({ kind: "ticked", op: "box-ship", resumed: question });
    expect((third[0] as { result: { status: string } }).result.status).toBe("ok");
    expect(log).toEqual(["ship"]);
    expect((await readMemberStewards(root, "local", "2027-01-01T00:11:00Z")).stewards[0].waiting).toEqual([]);
  });
});
