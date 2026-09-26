/**
 * The decide activity against the stub backend (#2740): a noul, a choice and
 * a score answered and recorded, the run waiting on an open question until a
 * person answers, reuse, the threshold, an unreachable backend escalating or
 * failing as the point declares, brokered and literal keys, a steward's turn,
 * and inputs read through the read contract.
 */

import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { enterStewardTurn, isPointWait, resetStewardTurn, type WaitingPoint } from "@intentius/chant/op";
import { loadActivities } from "@intentius/chant/op/activity-registry";
import { answerPoint, type QuestionView } from "@intentius/chant/workspace/decide";
import { workspacePoints } from "@intentius/chant/workspace/points-cli";
import type { WireAnswer } from "@intentius/chant/workspace/points";
import { startStubBackend, type StubBackend } from "../../stub-backend";
import { cleanScratch, MODEL, recordText, workspace } from "../../__fixtures__/workspace";
import { DecideError, runDecide, type DecideArgs } from "./decide";

const KEY = "stub-key-not-a-secret";
const env = { STUB_KEY: KEY, LOBBY_TOKEN: KEY };
const on = "2026-09-25";

let root: string;
let stub: StubBackend;
/** What the stub answers, by question name, when a test sets it. */
let script: Record<string, WireAnswer> = {};

const backends = (url = stub.url) => ({ systemone: { url, key: { env: "STUB_KEY" } } });
const ask = (args: Omit<DecideArgs, "cwd" | "backends"> & { backends?: DecideArgs["backends"] }) => runDecide({ cwd: root, backends: backends(), ...args }, { env, on });
const answers = () => readdirSync(join(root, "answers")).filter((f) => f.endsWith(".md")).sort();

/** The question an open ask stopped the run on: the step threw core's PointWait. */
async function waitsOn(p: Promise<unknown>): Promise<WaitingPoint> {
  const err = await p.then(
    (r) => {
      throw new Error(`expected the run to wait, and the step returned ${JSON.stringify(r)}`);
    },
    (e: unknown) => e,
  );
  if (!isPointWait(err)) throw err;
  return err.question;
}

/** The question as the read contract lists it. */
async function question(id: string): Promise<QuestionView> {
  const doc = await workspacePoints({ cwd: root });
  if ("error" in doc) throw new Error(doc.error.message);
  const q = doc.questions.find((x) => x.id === id);
  if (!q) throw new Error(`no question ${id}`);
  return q;
}

beforeAll(async () => {
  root = workspace();
  stub = await startStubBackend({ key: KEY, answers: (q) => script[q.name] ?? (undefined as unknown as WireAnswer) });
});

afterEach(() => resetStewardTurn());

afterAll(async () => {
  await stub.close();
  cleanScratch();
});

describe("decide against the stub (#2740)", () => {
  test("a noul: the model's answer at the threshold is recorded as proposed, and the run waits on it", async () => {
    script = { triage: { type: "noul", noul: 0.91 } };
    const w = await waitsOn(ask({ point: "triage", inputs: { "record.size": 5, "record.risky": true }, subject: "T-1" }));
    expect(w).toMatchObject({ point: "triage", state: "proposed", subject: "T-1", steward: null });
    const q = await question(w.id);
    expect(q).toMatchObject({ state: "proposed", open: true, answer: true, decider: { kind: "model", backend: "systemone", model: MODEL }, confidence: 0.91, threshold: 0.8, valid: true });
    expect(q.escalations).toEqual([{ kind: "table", reason: "no row matches these inputs" }]);
    expect(recordText(root, w.path)).toContain(`model: "${MODEL}"`);
    // The request went out in the wire format, with the pinned model and the bearer key.
    expect(stub.requests[stub.requests.length - 1]).toEqual({
      model: MODEL,
      state: { "record.size": 5, "record.risky": true },
      questions: { triage: { type: "noul", instructions: "Does the task need a person to look at it today?", criteria: { true: "A person looks at it today.", false: "It can wait." } } },
    });
    expect(stub.authorizations[stub.authorizations.length - 1]).toBe(`Bearer ${KEY}`);
  });

  test("once a person confirms the proposal, the next run reads the answer and calls nothing", async () => {
    const w = await waitsOn(ask({ point: "triage", inputs: { "record.risky": true, "record.size": 5 }, subject: "T-1" }));
    const before = stub.requests.length;
    const files = answers();
    const confirmed = await answerPoint({ cwd: root, id: w.id, answer: true, by: ["alice"], on });
    if ("error" in confirmed) throw new Error(confirmed.error.message);
    const r = await ask({ point: "triage", inputs: { "record.size": 5, "record.risky": true }, subject: "T-1" });
    expect(r).toMatchObject({ id: w.id, state: "answered", open: false, answer: true, decider: "model", model: MODEL, backend: "systemone", confidence: 0.91, answeredBy: ["alice"] });
    expect(stub.requests.length).toBe(before);
    expect(answers()).toEqual(files);
  });

  test("a choice: the choice and its probabilities are recorded", async () => {
    script = { route: { type: "choice", choice: "platform", probabilities: { platform: 0.86, app: 0.1, docs: 0.04 }, confidence: 0.84 } };
    const w = await waitsOn(ask({ point: "route", inputs: { "record.title": "Rotate the deploy key", "record.size": 5 }, subject: "T-1" }));
    expect(await question(w.id)).toMatchObject({ state: "proposed", answer: "platform", confidence: 0.84, probabilities: { platform: 0.86, app: 0.1, docs: 0.04 } });
  });

  test("a score: the most probable level is the answer", async () => {
    script = { effort: { type: "score", score: 2.7, legend: { 1: "low", 2: "medium", 3: "high" }, probabilities: { low: 0.02, medium: 0.1, high: 0.88 }, confidence: 0.82 } };
    const w = await waitsOn(ask({ point: "effort", inputs: { "record.size": 5, "member.kind": "other" }, subject: "T-1" }));
    expect(await question(w.id)).toMatchObject({ state: "proposed", answer: "high", confidence: 0.82 });
  });

  test("an open question asked again is reused: no second call, no second record", async () => {
    const before = stub.requests.length;
    const files = answers();
    const w = await waitsOn(ask({ point: "route", inputs: { "record.size": 5, "record.title": "Rotate the deploy key" }, subject: "T-1" }));
    expect(w.state).toBe("proposed");
    expect(stub.requests.length).toBe(before);
    expect(answers()).toEqual(files);
  });

  test("a table row answers before the model is asked, and the step returns it", async () => {
    const before = stub.requests.length;
    const r = await ask({ point: "triage", inputs: { "record.size": 0, "record.risky": false } });
    expect(r).toMatchObject({ state: "answered", open: false, answer: false, decider: "table", model: null });
    expect(stub.requests.length).toBe(before);
  });

  test("below the threshold the question escalates to people, with the model's lean", async () => {
    script = { triage: { type: "noul", noul: 0.6 } };
    const w = await waitsOn(ask({ point: "triage", inputs: { "record.size": 3, "record.risky": false } }));
    expect(w.state).toBe("escalated");
    const q = await question(w.id);
    expect(q.model).toMatchObject({ answer: true, confidence: 0.6, threshold: 0.8, observed: false });
    expect(q.escalations[1].reason).toContain("below the threshold");
  });

  test("a dry run asks, writes nothing, and returns the question whatever its state", async () => {
    script = { triage: { type: "noul", noul: 0.05 } };
    const files = answers();
    const r = await ask({ point: "triage", inputs: { "record.size": 8, "record.risky": false }, dryRun: true });
    expect(r).toMatchObject({ state: "proposed", open: true, answer: false, decider: "model" });
    expect(answers()).toEqual(files);
  });
});

describe("an unreachable backend follows the point's unreachable", () => {
  let gone: string;
  beforeAll(async () => {
    const s = await startStubBackend();
    gone = s.url;
    await s.close();
  });

  test("escalate (the default): the question is open for people, with why", async () => {
    const w = await waitsOn(ask({ point: "triage", inputs: { "record.size": 2, "record.risky": true }, backends: backends(gone) }));
    expect(w.state).toBe("escalated");
    const e = (await question(w.id)).escalations[1];
    expect(e).toMatchObject({ kind: "model", backend: "systemone", model: MODEL });
    expect(e.reason).toMatch(/^not observed: systemone could not answer: systemone at http:\/\/127\.0\.0\.1:\d+\/v1\/systemone/);
  });

  test("fail: nothing is written and the step fails", async () => {
    const files = answers();
    const err = await ask({ point: "route", inputs: { "record.title": "Write the release notes", "record.size": 2 }, backends: backends(gone) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecideError);
    expect((err as DecideError).code).toBe("point-decider-failed");
    expect((err as Error).message).toContain('unreachable: "fail"');
    expect(answers()).toEqual(files);
  });

  test("a 429 from the backend is unreachable too", async () => {
    const busy = await startStubBackend({ status: 429 });
    try {
      const w = await waitsOn(runDecide({ cwd: root, point: "triage", inputs: { "record.size": 4, "record.risky": true }, backends: { systemone: { url: busy.url } } }, { on }));
      expect((await question(w.id)).escalations[1].reason).toContain("answered 429");
    } finally {
      await busy.close();
    }
  });

  test("an unset key variable is unreachable, and the point decides", async () => {
    const w = await waitsOn(runDecide({ cwd: root, point: "triage", inputs: { "record.size": 6, "record.risky": true }, backends: backends() }, { env: {}, on }));
    expect((await question(w.id)).escalations[1].reason).toContain("the environment variable STUB_KEY is not set");
  });
});

describe("the key", () => {
  test("a brokered capability declared on the box: the broker's variable carries the key", async () => {
    script = { triage: { type: "noul", noul: 0.97 } };
    const w = await waitsOn(ask({ point: "triage", inputs: { "record.size": 9, "record.risky": true }, backends: { systemone: { url: stub.url, key: { capability: "inference", member: "box", env: "LOBBY_TOKEN" } } } }));
    expect(w.state).toBe("proposed");
    expect(stub.authorizations[stub.authorizations.length - 1]).toBe(`Bearer ${KEY}`);
  });

  test("a brokered capability without env sends no key: the broker is the endpoint", async () => {
    const open = await startStubBackend();
    try {
      const w = await waitsOn(ask({ point: "triage", inputs: { "record.size": 10, "record.risky": true }, backends: { systemone: { url: open.url, key: { capability: "inference" } } } }));
      expect(w.state).toBe("proposed");
      expect(open.authorizations).toEqual([null]);
    } finally {
      await open.close();
    }
  });

  test.each([
    ["a capability with no broker", { capability: "raw", member: "box", env: "LOBBY_TOKEN" }, "names no broker"],
    ["a capability no box declares", { capability: "fountain" }, "no member's box declares the capability fountain"],
    ["a literal string", "sk-not-a-real-key", "is a literal string"],
  ])("%s is refused before anything is asked or written", async (_label, key, message) => {
    const before = stub.requests.length;
    const files = answers();
    const err = await ask({ point: "triage", inputs: { "record.size": 11, "record.risky": true }, backends: { systemone: { url: stub.url, key } } as never }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecideError);
    expect((err as DecideError).code).toBe("backend-invalid");
    expect((err as Error).message).toContain(message);
    expect(stub.requests.length).toBe(before);
    expect(answers()).toEqual(files);
  });

  test("a backend the point names but nobody configured is refused", async () => {
    const err = await ask({ point: "triage", inputs: { "record.size": 12, "record.risky": true }, backends: { other: { url: stub.url } } }).catch((e: unknown) => e);
    expect((err as DecideError).code).toBe("backend-invalid");
    expect((err as Error).message).toContain("names the backend systemone, and none is configured (systemone.backends: other)");
  });
});

describe("in a steward's turn (#2749)", () => {
  const brokered = { systemone: { url: "", key: { capability: "inference", member: "box", env: "LOBBY_TOKEN" } } };

  test("the call goes through a capability the steward declares, and the question names the steward", async () => {
    enterStewardTurn({ steward: "keeper", capabilities: ["inference"], run: "run-1" });
    script = { triage: { type: "noul", noul: 0.95 } };
    const before = stub.requests.length;
    const w = await waitsOn(ask({ point: "triage", inputs: { "record.size": 14, "record.risky": true }, backends: { systemone: { ...brokered.systemone, url: stub.url } } }));
    expect(w).toMatchObject({ state: "proposed", steward: "keeper" });
    expect(stub.requests.length).toBe(before + 1);
    expect((await question(w.id)).askedBy).toEqual({ steward: "keeper", run: "run-1" });
  });

  test("a steward that does not declare the capability makes no call, and the question goes to people", async () => {
    enterStewardTurn({ steward: "keeper", capabilities: [] });
    const before = stub.requests.length;
    const w = await waitsOn(ask({ point: "triage", inputs: { "record.size": 15, "record.risky": true }, backends: { systemone: { ...brokered.systemone, url: stub.url } } }));
    expect(w.state).toBe("escalated");
    expect(stub.requests.length).toBe(before);
    expect((await question(w.id)).escalations[1].reason).toContain("does not name the brokered capability inference");
  });

  test("a backend keyed by an environment variable is not called: the steward would hold the key", async () => {
    enterStewardTurn({ steward: "keeper", capabilities: ["inference"] });
    const before = stub.requests.length;
    const w = await waitsOn(ask({ point: "triage", inputs: { "record.size": 16, "record.risky": true } }));
    expect(w.state).toBe("escalated");
    expect(stub.requests.length).toBe(before);
    expect((await question(w.id)).escalations[1].reason).toContain("key is the environment variable STUB_KEY");
  });
});

describe("inputs read through the read contract", () => {
  test("a record by id gives each record.* input its field, and a member by name its own", async () => {
    script = { effort: { type: "score", probabilities: { low: 0.9, medium: 0.08, high: 0.02 }, confidence: 0.85 } };
    const w = await waitsOn(ask({ point: "effort", read: { record: "T-2", member: "app" }, subject: "T-2" }));
    expect(stub.requests[stub.requests.length - 1].state).toEqual({ "record.size": 1, "member.kind": "other" });
    expect(await question(w.id)).toMatchObject({ answer: "low", inputs: { "record.size": 1, "member.kind": "other" } });
  });

  test("an input passed as a value wins over the one read", async () => {
    script = { triage: { type: "noul", noul: 0.02 } };
    await waitsOn(ask({ point: "triage", read: { record: "T-2" }, inputs: { "record.risky": true } }));
    expect(stub.requests[stub.requests.length - 1].state).toEqual({ "record.size": 1, "record.risky": true });
  });

  test("a record that is not there, and an output not read by id, are refused", async () => {
    await expect(ask({ point: "triage", read: { record: "T-99" } })).rejects.toMatchObject({ code: "point-inputs-invalid", message: expect.stringContaining("no declared record kind holds a record with id T-99") });
    await expect(ask({ point: "triage", read: { finding: "f-1" } })).rejects.toMatchObject({ code: "point-inputs-invalid", message: expect.stringContaining("finding is not read by id here") });
  });
});

describe("the activity as an Op step runs it", () => {
  test("loadActivities(['systemone']) registers decide", async () => {
    const activities = await loadActivities(["systemone"]);
    expect(typeof activities.get("decide")).toBe("function");
  });

  test("backends come from systemone.backends in the project's chant.config", async () => {
    writeFileSync(join(root, "chant.config.json"), JSON.stringify({ lexicons: ["systemone"], systemone: { backends: { systemone: { url: stub.url, key: { env: "STUB_KEY" } } } } }));
    try {
      script = { triage: { type: "noul", noul: 0.93 } };
      const before = stub.requests.length;
      const w = await waitsOn(runDecide({ cwd: root, point: "triage", inputs: { "record.size": 13, "record.risky": true } }, { env, on }));
      expect(w.state).toBe("proposed");
      expect(stub.requests.length).toBe(before + 1);
    } finally {
      rmSync(join(root, "chant.config.json"));
    }
  });

  test("an unknown point is refused", async () => {
    await expect(ask({ point: "nope" })).rejects.toMatchObject({ code: "point-unknown" });
    expect(existsSync(join(root, "answers"))).toBe(true);
  });
});
