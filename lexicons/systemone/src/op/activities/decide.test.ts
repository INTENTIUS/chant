/**
 * The decide activity against the stub backend (#2740): a noul, a choice and
 * a score answered and recorded, reuse, the threshold, an unreachable backend
 * escalating or failing as the point declares, brokered and literal keys, and
 * inputs read through the read contract.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadActivities } from "@intentius/chant/op/activity-registry";
import { queryRecords } from "@intentius/chant/workspace/records-cli";
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

beforeAll(async () => {
  root = workspace();
  stub = await startStubBackend({ key: KEY, answers: (q) => script[q.name] ?? (undefined as unknown as WireAnswer) });
});

afterAll(async () => {
  await stub.close();
  cleanScratch();
});

describe("decide against the stub (#2740)", () => {
  test("a noul: the model's answer at the threshold is recorded as proposed, with its values and source", async () => {
    script = { triage: { type: "noul", noul: 0.91 } };
    const r = await ask({ point: "triage", inputs: { "record.size": 5, "record.risky": true }, subject: "T-1" });
    expect(r).toMatchObject({ state: "proposed", open: true, answer: true, decider: "model", model: MODEL, backend: "systemone", confidence: 0.91, threshold: 0.8, reused: false, written: true });
    expect(r.escalations).toEqual([{ kind: "table", reason: "no row matches these inputs" }]);
    const text = recordText(root, r.path);
    expect(text).toContain('state: "proposed"');
    expect(text).toContain(`model: "${MODEL}"`);
    // The request went out in the wire format, with the pinned model and the bearer key.
    const req = stub.requests[stub.requests.length - 1];
    expect(req).toEqual({
      model: MODEL,
      state: { "record.size": 5, "record.risky": true },
      questions: { triage: { type: "noul", instructions: "Does the task need a person to look at it today?", criteria: { true: "A person looks at it today.", false: "It can wait." } } },
    });
    expect(stub.authorizations[stub.authorizations.length - 1]).toBe(`Bearer ${KEY}`);
    // The record reads back valid through the read contract.
    const records = await queryRecords({ kind: "answers/answer.kind.mjs", cwd: root });
    if ("error" in records) throw new Error(records.error.message);
    expect(records.records.find((x) => x.id === r.id)).toMatchObject({ valid: true, state: "proposed" });
  });

  test("a choice: the choice and its probabilities are recorded", async () => {
    script = { route: { type: "choice", choice: "platform", probabilities: { platform: 0.86, app: 0.1, docs: 0.04 }, confidence: 0.84 } };
    const r = await ask({ point: "route", inputs: { "record.title": "Rotate the deploy key", "record.size": 5 }, subject: "T-1" });
    expect(r).toMatchObject({ state: "proposed", answer: "platform", confidence: 0.84, threshold: 0.8 });
    expect(recordText(root, r.path)).toContain("platform: 0.86");
  });

  test("a score: the most probable level is the answer", async () => {
    script = { effort: { type: "score", score: 2.7, legend: { 1: "low", 2: "medium", 3: "high" }, probabilities: { low: 0.02, medium: 0.1, high: 0.88 }, confidence: 0.82 } };
    const r = await ask({ point: "effort", inputs: { "record.size": 5, "member.kind": "other" }, subject: "T-1" });
    expect(r).toMatchObject({ state: "proposed", answer: "high", confidence: 0.82 });
  });

  test("the same point and inputs are answered once: asking again reuses the record and calls nothing", async () => {
    const before = stub.requests.length;
    const files = answers();
    const r = await ask({ point: "triage", inputs: { "record.risky": true, "record.size": 5 }, subject: "T-1" });
    expect(r).toMatchObject({ reused: true, written: false, state: "proposed" });
    expect(stub.requests.length).toBe(before);
    expect(answers()).toEqual(files);
  });

  test("a table row answers before the model is asked", async () => {
    const before = stub.requests.length;
    const r = await ask({ point: "triage", inputs: { "record.size": 0, "record.risky": false } });
    expect(r).toMatchObject({ state: "answered", open: false, answer: false, decider: "table", model: null });
    expect(stub.requests.length).toBe(before);
  });

  test("below the threshold the question escalates to people, with the model's lean", async () => {
    script = { triage: { type: "noul", noul: 0.6 } };
    const r = await ask({ point: "triage", inputs: { "record.size": 3, "record.risky": false } });
    expect(r).toMatchObject({ state: "escalated", open: true, answer: null, decider: "quorum" });
    expect(r.escalations[1]).toMatchObject({ kind: "model", model: MODEL, answer: true, confidence: 0.6, threshold: 0.8 });
    expect(r.escalations[1].reason).toContain("below the threshold");
  });

  test("dry run asks and writes nothing", async () => {
    script = { triage: { type: "noul", noul: 0.05 } };
    const files = answers();
    const r = await ask({ point: "triage", inputs: { "record.size": 8, "record.risky": false }, dryRun: true });
    expect(r).toMatchObject({ state: "proposed", answer: false, written: false });
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
    const r = await ask({ point: "triage", inputs: { "record.size": 2, "record.risky": true }, backends: backends(gone) });
    expect(r).toMatchObject({ state: "escalated", written: true, decider: "quorum" });
    expect(r.escalations[1]).toMatchObject({ kind: "model", backend: "systemone", model: MODEL });
    expect(r.escalations[1].reason).toMatch(/^not observed: systemone could not answer: systemone at http:\/\/127\.0\.0\.1:\d+\/v1\/systemone/);
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
      const r = await runDecide({ cwd: root, point: "triage", inputs: { "record.size": 4, "record.risky": true }, backends: { systemone: { url: busy.url } } }, { on });
      expect(r.state).toBe("escalated");
      expect(r.escalations[1].reason).toContain("answered 429");
    } finally {
      await busy.close();
    }
  });

  test("an unset key variable is unreachable, and the point decides", async () => {
    const r = await runDecide({ cwd: root, point: "triage", inputs: { "record.size": 6, "record.risky": true }, backends: backends() }, { env: {}, on });
    expect(r.state).toBe("escalated");
    expect(r.escalations[1].reason).toContain("the environment variable STUB_KEY is not set");
  });
});

describe("the key", () => {
  test("a brokered capability declared on the box: the broker's variable carries the key", async () => {
    script = { triage: { type: "noul", noul: 0.97 } };
    const r = await ask({ point: "triage", inputs: { "record.size": 9, "record.risky": true }, backends: { systemone: { url: stub.url, key: { capability: "inference", member: "box", env: "LOBBY_TOKEN" } } } });
    expect(r).toMatchObject({ state: "proposed", answer: true });
    expect(stub.authorizations[stub.authorizations.length - 1]).toBe(`Bearer ${KEY}`);
  });

  test("a brokered capability without env sends no key: the broker is the endpoint", async () => {
    const open = await startStubBackend();
    try {
      const r = await ask({ point: "triage", inputs: { "record.size": 10, "record.risky": true }, backends: { systemone: { url: open.url, key: { capability: "inference" } } } });
      expect(r.state).toBe("proposed");
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

describe("inputs read through the read contract", () => {
  test("a record by id gives each record.* input its field, and a member by name its own", async () => {
    script = { effort: { type: "score", probabilities: { low: 0.9, medium: 0.08, high: 0.02 }, confidence: 0.85 } };
    const r = await ask({ point: "effort", read: { record: "T-2", member: "app" }, subject: "T-2" });
    expect(r).toMatchObject({ state: "proposed", answer: "low", missing: [] });
    expect(stub.requests[stub.requests.length - 1].state).toEqual({ "record.size": 1, "member.kind": "other" });
  });

  test("an input passed as a value wins over the one read", async () => {
    script = { triage: { type: "noul", noul: 0.02 } };
    const r = await ask({ point: "triage", read: { record: "T-2" }, inputs: { "record.risky": true } });
    expect(stub.requests[stub.requests.length - 1].state).toEqual({ "record.size": 1, "record.risky": true });
    expect(r.answer).toBe(false);
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
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "chant.config.json"), JSON.stringify({ lexicons: ["systemone"], systemone: { backends: { systemone: { url: stub.url, key: { env: "STUB_KEY" } } } } }));
    try {
      script = { triage: { type: "noul", noul: 0.93 } };
      const r = await runDecide({ cwd: root, point: "triage", inputs: { "record.size": 13, "record.risky": true } }, { env, on });
      expect(r).toMatchObject({ state: "proposed", answer: true });
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(join(root, "chant.config.json"));
    }
  });

  test("an unknown point is refused", async () => {
    await expect(ask({ point: "nope" })).rejects.toMatchObject({ code: "point-unknown" });
    expect(existsSync(join(root, "answers"))).toBe(true);
  });
});
