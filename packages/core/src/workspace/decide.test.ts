/**
 * Answers to decision points as records (ws-058, #2739), with a stub model
 * decider, on a workspace in a throwaway git repository: `points ask` and
 * `points answer` as `decide.ts` runs them, `points --json` as
 * `points-cli.ts` prints it, and WSP116 in `check`.
 */

import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "./checks";
import { cleanScratch, commitAll, contract, REPO, repo } from "./__fixtures__/contract-repo";
import { answerFields, answerPoint, askPoint, reasonFields, retractAnswer, type PointsWriteDocument } from "./decide";
import pointAnswerSchema from "./point-answer.schema.json";
import { responseAsk, workspacePoints } from "./points-cli";
import pointsSchema from "./points.schema.json";
import pointsWriteSchema from "./points-write.schema.json";
import { parsePoints, type ModelAsk, type WireAnswer } from "./points";
import { queryRecords } from "./records-cli";

const REF = join(REPO, "reference-workspace");
const POINTS = JSON.parse(readFileSync(join(REF, "decisions", "points.json"), "utf-8")) as { points: Record<string, unknown> };

const points = {
  points: {
    ...POINTS.points,
    "needs-decision": {
      title: "Does this change need a decision",
      question: { type: "noul", instructions: "Does the change make a choice nobody has recorded?", criteria: { true: "It needs a decision.", false: "It does not." } },
      inputs: { commit: "the commit, as graph --intent lists it" },
      deciders: [
        { kind: "model", backend: "systemone", model: "jev-1.13.0", threshold: 0.8 },
        { kind: "quorum", count: 2, roles: ["lead"] },
      ],
    },
  },
};

const write = contract(pointsWriteSchema);
const read = contract(pointsSchema);

let root: string;
const on = "2026-09-25";

/** A stub model decider answering every point with `answer`, at the pinned model. */
const stub =
  (answer: WireAnswer): ModelAsk =>
  async (req) => ({ model: req.model, answer });

const big = { "work-item.criteria": 9, "work-item.fits_small": false, "work-item.fits_medium": false };
const confident: WireAnswer = { type: "choice", choice: "large", probabilities: { small: 0.01, medium: 0.07, large: 0.92 }, confidence: 0.88 };
const unsure: WireAnswer = { type: "choice", choice: "medium", probabilities: { small: 0.2, medium: 0.45, large: 0.35 }, confidence: 0.175 };

function ok(doc: PointsWriteDocument): Extract<PointsWriteDocument, { question: unknown }> {
  write.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

function refused(doc: PointsWriteDocument): string {
  write.expectValid(doc);
  if (!("error" in doc)) throw new Error("expected a refusal");
  return doc.error.code;
}

const answers = () => readdirSync(join(root, "answers")).filter((f) => f.endsWith(".md")).sort();
const fm = (path: string) => readFileSync(join(root, path), "utf-8");

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
      ".chant/trust.json": JSON.stringify({ schema: 1, roles: { agent: ["bot"], lead: ["alice", "bob", "bot"] } }),
    },
    false,
  );
  cpSync(join(REF, "answers", "answer.kind.mjs"), join(root, "answers", "answer.kind.mjs"), { recursive: true });
  cpSync(join(REF, "answers", "answer.schema.json"), join(root, "answers", "answer.schema.json"));
  commitAll(root, "c0");
});

afterAll(cleanScratch);

describe("points ask (#2739)", () => {
  test("a table's answer is answered at once", async () => {
    const doc = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { "work-item.fits_small": true }, subject: "W-001", on }));
    expect(doc.question).toMatchObject({ state: "answered", open: false, answer: "small", decider: { kind: "table", row: 0 }, subject: "W-001", answeredOn: on, model: null });
    expect(doc.written).toBe(true);
  });

  test("a model answer at or above its threshold is written as proposed, with its values and source", async () => {
    const doc = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: big, subject: "W-002", ask: stub(confident), on }));
    expect(doc.question).toMatchObject({
      state: "proposed",
      open: true,
      answer: "large",
      decider: { kind: "model", backend: "systemone", model: "bosun-v3.1-1.7b" },
      probabilities: { small: 0.01, medium: 0.07, large: 0.92 },
      confidence: 0.88,
      threshold: 0.8,
      model: { answer: "large", confidence: 0.88, threshold: 0.8, observed: true },
      escalations: [{ kind: "table", reason: "no row matches these inputs" }],
    });
    expect(doc.id).toBe(`slice-tier-${doc.question.inputsHash.slice(0, 12)}`);
    expect(fm(doc.path)).toContain('source:\n  via: "cli"\n  model: "bosun-v3.1-1.7b"');
    const records = await queryRecords({ kind: "answers/answer.kind.mjs", cwd: root });
    if ("error" in records) throw new Error(records.error.message);
    expect(records.records.find((r) => r.id === doc.id)).toMatchObject({ valid: true, state: "proposed", warnings: [] });
  });

  test("asking again with the same inputs returns the existing record", async () => {
    const before = answers();
    const first = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: big, subject: "W-002", ask: stub(unsure), on }));
    // Key order does not matter: the inputs hash over canonical JSON.
    const again = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: Object.fromEntries(Object.entries(big).reverse()), ask: stub(unsure) }));
    for (const d of [first, again]) expect(d).toMatchObject({ reused: true, written: false, question: { state: "proposed", answer: "large" } });
    expect(answers()).toEqual(before);
  });

  test("below its threshold the question is escalated and listed as open for a quorum, with the model's answer", async () => {
    const doc = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { ...big, "work-item.criteria": 12 }, subject: "W-003", ask: stub(unsure), on }));
    expect(doc.question).toMatchObject({ state: "escalated", open: true, answer: null, decider: { kind: "quorum", count: 1 } });
    expect(fm(doc.path)).not.toMatch(/^answer:/m);
    const listed = await workspacePoints({ cwd: root, open: true });
    read.expectValid(listed);
    if ("error" in listed) throw new Error(listed.error.message);
    const q = listed.questions.find((x) => x.id === doc.id)!;
    expect(q).toMatchObject({ state: "escalated", open: true, current: true, model: { answer: "medium", confidence: 0.175, threshold: 0.8, model: "bosun-v3.1-1.7b", observed: false } });
    expect(q.escalations.map((e) => e.reason)).toEqual(["no row matches these inputs", "not observed: confidence 0.175 is below the threshold 0.8"]);
    expect(listed.questions.every((x) => x.open)).toBe(true);
    expect(listed.points.map((p) => p.name)).toEqual(["slice-tier", "ship-skip", "finding-triage", "needs-a-decision", "intent-origin", "intent-judgment", "intent-disposition", "agent-question", "needs-decision"]);
    expect(listed.points[0].inputs[0]).toEqual({ name: "work-item.criteria", output: "work-item", description: "acceptance criteria in the work item" });

    // A later ask still escalating keeps the standing record; one a model answers rewrites it, as proposed.
    const still = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { ...big, "work-item.criteria": 12 } }));
    expect(still).toMatchObject({ reused: true, question: { state: "escalated" } });
    const now = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { ...big, "work-item.criteria": 12 }, ask: stub(confident), on }));
    expect(now).toMatchObject({ id: doc.id, path: doc.path, reused: false, question: { state: "proposed", subject: "W-003", answer: "large" } });
  });

  test("with --dry-run nothing is written, and the text is returned", async () => {
    const before = answers();
    const doc = ok(await askPoint({ cwd: root, point: "ship-skip", inputs: { "release.units": 3 }, dryRun: true, on }));
    expect(doc).toMatchObject({ written: false, dryRun: true, question: { state: "answered", answer: false } });
    expect((doc as { text?: string }).text).toContain("answer: false");
    expect(answers()).toEqual(before);
  });

  test("refusals: an unknown point, undeclared inputs, a closed-failing backend", async () => {
    expect(refused(await askPoint({ cwd: root, point: "nope", inputs: {} }))).toBe("point-unknown");
    expect(refused(await askPoint({ cwd: root, point: "slice-tier", inputs: { "contract.size": 3 } }))).toBe("point-inputs-invalid");
    expect(refused(await askPoint({ cwd: root, point: "slice-tier", inputs: [] }))).toBe("point-inputs-invalid");
  });
});

describe("points answer (#2739)", () => {
  test("a person confirms a model's proposal, which keeps the model as its decider", async () => {
    const asked = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: big, ask: stub(confident) }));
    const doc = ok(await answerPoint({ cwd: root, id: asked.id, answer: "large", by: ["alice"], on }));
    expect(doc.question).toMatchObject({ state: "answered", open: false, answer: "large", decider: { kind: "model", model: "bosun-v3.1-1.7b" }, confidence: 0.88, answeredBy: ["alice"], answeredOn: on });
    expect(refused(await answerPoint({ cwd: root, id: asked.id, answer: "small", by: ["alice"] }))).toBe("record-closed");
    // Asking again returns the confirmed answer.
    expect(ok(await askPoint({ cwd: root, point: "slice-tier", inputs: big, ask: stub(unsure) }))).toMatchObject({ reused: true, question: { state: "answered" } });
  });

  test("people answering otherwise is the quorum's answer, and the proposal moves into the escalations", async () => {
    const asked = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { ...big, "work-item.criteria": 4 }, ask: stub(confident), on }));
    expect(refused(await answerPoint({ cwd: root, id: asked.id, answer: "tiny", by: ["alice"] }))).toBe("answer-not-candidate");
    const doc = ok(await answerPoint({ cwd: root, id: asked.id, answer: "medium", by: ["bob"], on }));
    expect(doc.question).toMatchObject({ state: "answered", answer: "medium", decider: { kind: "quorum", count: 1, by: ["bob"] }, probabilities: null, confidence: null });
    expect(doc.question.escalations.at(-1)).toMatchObject({ kind: "model", answer: "large", confidence: 0.88, reason: "proposed large, and people answered medium" });
  });

  test("the quorum counts distinct people holding its roles, never an agent", async () => {
    const asked = ok(await askPoint({ cwd: root, point: "needs-decision", inputs: { commit: { sha: "abc" } }, ask: stub({ type: "noul", noul: 0.55 }), on }));
    expect(asked.question).toMatchObject({ state: "escalated", model: { answer: true, confidence: 0.55, observed: false } });
    expect(refused(await answerPoint({ cwd: root, id: asked.id, answer: "yes", by: ["alice", "Alice ", "bot", "carol"] }))).toBe("quorum-not-met");
    const doc = ok(await answerPoint({ cwd: root, id: asked.id, answer: "yes", by: ["alice", "bob"], on }));
    expect(doc.question).toMatchObject({ state: "answered", answer: true, decider: { kind: "quorum", count: 2, roles: ["lead"], by: ["alice", "bob"] } });
  });

  test("an unknown id is refused", async () => {
    expect(refused(await answerPoint({ cwd: root, id: "slice-tier-000000000000", answer: "small", by: ["alice"] }))).toBe("record-not-found");
  });

  test("every record written follows point-answer.schema.json, and the reference workspace carries a copy of it", () => {
    expect(JSON.parse(readFileSync(join(REF, "answers", "answer.schema.json"), "utf-8"))).toEqual(pointAnswerSchema);
    expect(answers().length).toBeGreaterThan(3);
  });
});

describe("the model's reason (#3345)", () => {
  const why = "Nine acceptance criteria across three services: more than a medium slice holds.";

  test("a proposal keeps the model's reason, from --response too; points --json returns it, and confirming keeps it", async () => {
    const response = { model: "bosun-v3.1-1.7b", answers: { "slice-tier": { ...confident, reason: why } } };
    const asked = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { ...big, "work-item.criteria": 20 }, ask: responseAsk(response), on }));
    expect(asked.question).toMatchObject({ state: "proposed", reason: why, model: { answer: "large", observed: true, reason: why } });
    expect(fm(asked.path)).toContain(`reason: ${JSON.stringify(why)}`);
    const listed = await workspacePoints({ cwd: root });
    read.expectValid(listed);
    if ("error" in listed) throw new Error(listed.error.message);
    expect(listed.questions.find((q) => q.id === asked.id)).toMatchObject({ reason: why, model: { reason: why } });
    const confirmed = ok(await answerPoint({ cwd: root, id: asked.id, answer: "large", by: ["alice"], on }));
    expect(confirmed.question).toMatchObject({ state: "answered", decider: { kind: "model" }, reason: why });
  });

  test("people answering otherwise move the reason into the escalation, as model_reason", async () => {
    const asked = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { ...big, "work-item.criteria": 21 }, ask: stub({ ...confident, reason: why }), on }));
    const doc = ok(await answerPoint({ cwd: root, id: asked.id, answer: "medium", by: ["bob"], on }));
    expect(doc.question).toMatchObject({ decider: { kind: "quorum" }, reason: null });
    expect(doc.question.escalations.at(-1)).toMatchObject({ kind: "model", answer: "large", reason: "proposed large, and people answered medium", model_reason: why });
    expect(fm(doc.path)).not.toMatch(/^reason:/m);
  });

  test("an answer below the threshold keeps its reason in the escalation, and points --json shows it on the model's answer", async () => {
    const asked = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { ...big, "work-item.criteria": 22 }, ask: stub({ ...unsure, reason: "Could be either." }), on }));
    expect(asked.question).toMatchObject({ state: "escalated", reason: null, model: { answer: "medium", observed: false, reason: "Could be either." } });
    expect(asked.question.escalations[1]).toMatchObject({ kind: "model", model_reason: "Could be either." });
    expect(ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { ...big, "work-item.criteria": 23 }, ask: stub(unsure), on })).question.model).toMatchObject({ reason: null });
  });

  test("a workspace whose answer schema predates the reason keeps none, rather than failing the write", () => {
    expect(reasonFields(pointAnswerSchema)).toEqual({ top: true, escalation: true });
    const old = JSON.parse(JSON.stringify(pointAnswerSchema));
    delete old.properties.reason;
    delete old.definitions.escalation.properties.model_reason;
    expect(reasonFields(old)).toEqual({ top: false, escalation: false });
  });
});

describe("the intent walk's points, a note on an answer, and retracting it (#3351)", () => {
  const walk = (node: string) => ({ "region.id": "region:app/server.mjs:1-1", "node.id": node });

  test("the reference workspace declares the walk's three questions, each answered by the person walking", async () => {
    const listed = await workspacePoints({ cwd: root });
    read.expectValid(listed);
    if ("error" in listed) throw new Error(listed.error.message);
    const byName = Object.fromEntries(listed.points.map((p) => [p.name, p]));
    expect(byName["intent-origin"]).toMatchObject({ candidates: ["carried-out-decision", "incidental", "unknown"], quorum: { count: 1 } });
    expect(byName["intent-judgment"]).toMatchObject({ candidates: ["drift", "unwritten-supersession", "decision-wrong", "no-gap", "not-decidable"] });
    expect(byName["intent-disposition"]).toMatchObject({ candidates: ["handled", "skipped", "needs-discussion"] });
    for (const name of ["intent-origin", "intent-judgment", "intent-disposition"]) {
      expect(byName[name].inputs.map((i: { name: string; output: string }) => [i.name, i.output])).toEqual([["region.id", "region"], ["node.id", "node"]]);
      expect(byName[name].deciders.map((d: { kind: string }) => d.kind)).toEqual(["quorum"]);
    }
  });

  test("an answer keeps its note; retracting it escalates the question again and keeps the answer, its note and why", async () => {
    const asked = ok(await askPoint({ cwd: root, point: "intent-judgment", inputs: walk("decision:ref-001"), subject: "decision:ref-001", on }));
    expect(asked.question).toMatchObject({ state: "escalated", open: true, note: null, retractions: [] });
    expect(refused(await retractAnswer({ cwd: root, id: asked.id, by: ["alice"] }))).toBe("answer-not-answered");
    const answered = ok(await answerPoint({ cwd: root, id: asked.id, answer: "drift", by: ["alice"], note: "  The port moved off 8080.  ", on }));
    expect(answered.question).toMatchObject({ state: "answered", answer: "drift", note: "The port moved off 8080." });
    expect(fm(answered.path)).toContain('note: "The port moved off 8080."');
    expect(refused(await retractAnswer({ cwd: root, id: asked.id, by: ["bot"] }))).toBe("quorum-not-met");

    const retracted = ok(await retractAnswer({ cwd: root, id: asked.id, by: ["alice"], note: "Wrong decision.", on: "2026-09-26" }));
    expect(retracted.verb).toBe("retract");
    expect(retracted.question).toMatchObject({ state: "escalated", open: true, answer: null, note: null, answeredBy: [], answeredOn: null, decider: { kind: "quorum", count: 1 } });
    expect(retracted.question.retractions).toEqual([
      { answer: "drift", decider: { kind: "quorum", count: 1, by: ["alice"] }, answeredBy: ["alice"], answeredOn: on, answerNote: "The port moved off 8080.", by: ["alice"], on: "2026-09-26", note: "Wrong decision." },
    ]);
    expect(retracted.question.title).toMatch(/: open for people$/);
    // Asking again leaves it with people.
    expect(ok(await askPoint({ cwd: root, point: "intent-judgment", inputs: walk("decision:ref-001"), on }))).toMatchObject({ reused: true, question: { state: "escalated" } });

    const again = ok(await answerPoint({ cwd: root, id: asked.id, answer: "no-gap", by: ["bob"], on: "2026-09-27" }));
    expect(again.question).toMatchObject({ state: "answered", answer: "no-gap", note: null, answeredBy: ["bob"] });
    expect(again.question.retractions).toHaveLength(1);
    const listed = await workspacePoints({ cwd: root });
    read.expectValid(listed);
    if ("error" in listed) throw new Error(listed.error.message);
    expect(listed.questions.find((q) => q.id === asked.id)).toMatchObject({ answer: "no-gap", retractions: [{ answer: "drift", note: "Wrong decision." }] });
  });

  test("retracting a confirmed proposal puts the model's answer back among the escalations", async () => {
    const asked = ok(await askPoint({ cwd: root, point: "slice-tier", inputs: { ...big, "work-item.criteria": 30 }, ask: stub({ ...confident, reason: "Many criteria." }), on }));
    ok(await answerPoint({ cwd: root, id: asked.id, answer: "large", by: ["alice"], on }));
    const dry = ok(await retractAnswer({ cwd: root, id: asked.id, by: ["alice"], dryRun: true }));
    expect(dry).toMatchObject({ dryRun: true, written: false, question: { state: "escalated" } });
    expect(fm(asked.path)).toMatch(/^state: "answered"$/m);
    const doc = ok(await retractAnswer({ cwd: root, id: asked.id, by: ["alice"], on }));
    expect(doc.question).toMatchObject({ state: "escalated", decider: { kind: "quorum" }, probabilities: null, confidence: null, reason: null });
    expect(doc.question.retractions[0]).toMatchObject({ answer: "large", decider: { kind: "model", model: "bosun-v3.1-1.7b" } });
    expect(doc.question.escalations.at(-1)).toMatchObject({ kind: "model", answer: "large", reason: "proposed large, which people confirmed and then retracted", model_reason: "Many criteria." });
  });

  test("a workspace whose answer schema predates notes and retractions refuses them, rather than dropping them", () => {
    expect(answerFields(pointAnswerSchema)).toEqual({ note: true, retractions: true, asked: true });
    const old = JSON.parse(JSON.stringify(pointAnswerSchema));
    delete old.properties.note;
    delete old.properties.retractions;
    delete old.properties.asked;
    expect(answerFields(old)).toEqual({ note: false, retractions: false, asked: false });
  });
});

describe("an ad-hoc question whose candidates come with the ask (#3403)", () => {
  const room = {
    question: "Which language should the importer be written in?",
    criteria: { ts: "TypeScript: matches the rest of the repo.", py: "Python: the parser library is better." },
  };

  test("the reference workspace declares agent-question, ad hoc and decided by one person", async () => {
    const listed = await workspacePoints({ cwd: root });
    read.expectValid(listed);
    if ("error" in listed) throw new Error(listed.error.message);
    const p = listed.points.find((x) => x.name === "agent-question")!;
    expect(p).toMatchObject({ adhoc: true, questionType: "choice", candidates: [], criteria: {}, quorum: { count: 1 } });
    expect(p.inputs.map((i) => [i.name, i.output])).toEqual([["ask.id", "ask"], ["ask.by", "ask"]]);
    expect(listed.points.find((x) => x.name === "slice-tier")).toMatchObject({ adhoc: false });
  });

  test("the ask keeps the question and candidates; the answer is checked against them, noted, retracted and answered again", async () => {
    const inputs = { "ask.id": "req-1", "ask.by": "hud:session-7" };
    const asked = ok(await askPoint({ cwd: root, point: "agent-question", inputs, candidates: room, subject: "hud:session-7", on }));
    expect(asked.question).toMatchObject({
      state: "escalated",
      open: true,
      point: "agent-question",
      title: "Which language should the importer be written in? (hud:session-7): open for people",
      candidates: ["ts", "py"],
      asked: room,
      decider: { kind: "quorum", count: 1 },
    });
    const text = fm(asked.path);
    expect(text).toContain('asked:\n  question: "Which language should the importer be written in?"');
    expect(text).toContain("- ts: TypeScript: matches the rest of the repo.");

    // The same ask returns the same question; other options are another question.
    expect(ok(await askPoint({ cwd: root, point: "agent-question", inputs, candidates: room, on }))).toMatchObject({ reused: true, id: asked.id });
    const other = ok(await askPoint({ cwd: root, point: "agent-question", inputs, candidates: { ...room, criteria: { ...room.criteria, go: "Go." } }, on, dryRun: true }));
    expect(other.id).not.toBe(asked.id);

    expect(refused(await answerPoint({ cwd: root, id: asked.id, answer: "rust", by: ["alice"] }))).toBe("answer-not-candidate");
    const answered = ok(await answerPoint({ cwd: root, id: asked.id, answer: "py", by: ["alice"], note: "The parser decides it.", on }));
    expect(answered.question).toMatchObject({ state: "answered", answer: "py", answeredBy: ["alice"], note: "The parser decides it.", asked: room, title: "Which language should the importer be written in? (hud:session-7): py" });
    const retracted = ok(await retractAnswer({ cwd: root, id: asked.id, by: ["alice"], note: "Asked too early.", on }));
    expect(retracted.question).toMatchObject({ state: "escalated", asked: room, retractions: [{ answer: "py" }] });
    ok(await answerPoint({ cwd: root, id: asked.id, answer: "ts", by: ["bob"], on }));

    const listed = await workspacePoints({ cwd: root });
    read.expectValid(listed);
    if ("error" in listed) throw new Error(listed.error.message);
    expect(listed.questions.find((q) => q.id === asked.id)).toMatchObject({ state: "answered", answer: "ts", answeredBy: ["bob"], asked: room, candidates: ["ts", "py"] });
    expect(listed.questions.find((q) => q.point === "slice-tier")).toMatchObject({ asked: null });
  });

  test("refusals: no candidates for an ad-hoc point, candidates for a declared one, candidates that don't fit", async () => {
    const inputs = { "ask.id": "req-2" };
    expect(refused(await askPoint({ cwd: root, point: "agent-question", inputs }))).toBe("point-candidates-invalid");
    expect(refused(await askPoint({ cwd: root, point: "slice-tier", inputs: { "work-item.fits_small": true }, candidates: room }))).toBe("point-candidates-invalid");
    for (const bad of [[], { question: "Which?", criteria: { only: "One option." } }, { question: "", criteria: room.criteria }, { ...room, extra: 1 }, { question: "Which?", criteria: ["a", "b"] }]) {
      const doc = await askPoint({ cwd: root, point: "agent-question", inputs, candidates: bad });
      expect(refused(doc)).toBe("point-candidates-invalid");
    }
  });

  test("an ad-hoc point leaves out criteria and is decided by one quorum", () => {
    const base = { title: "Ad hoc", adhoc: true, question: { type: "choice", instructions: "Asked at runtime." }, inputs: { "ask.id": "the ask" } };
    expect(() => parsePoints(JSON.stringify({ points: { a: { ...base, deciders: [{ kind: "quorum", count: 1 }] } } }), "points.json")).not.toThrow();
    expect(() => parsePoints(JSON.stringify({ points: { a: { ...base, question: { ...base.question, criteria: { x: "X", y: "Y" } }, deciders: [{ kind: "quorum", count: 1 }] } } }), "points.json")).toThrow(/leave criteria out/);
    expect(() =>
      parsePoints(JSON.stringify({ points: { a: { ...base, deciders: [{ kind: "model", backend: "systemone", model: "jev-1.13.0", threshold: 0.8 }, { kind: "quorum", count: 1 }] } } }), "points.json"),
    ).toThrow(/decided by people alone/);
    expect(() => parsePoints(JSON.stringify({ points: { a: { ...base, adhoc: false, deciders: [{ kind: "quorum", count: 1 }] } } }), "points.json")).toThrow(/criteria/);
  });

  test("a workspace whose answer schema predates asked refuses an ad-hoc ask, rather than dropping the question", async () => {
    const schemaFile = join(root, "answers", "answer.schema.json");
    const original = readFileSync(schemaFile, "utf-8");
    const old = JSON.parse(original);
    delete old.properties.asked;
    writeFileSync(schemaFile, JSON.stringify(old, null, 2));
    try {
      expect(refused(await askPoint({ cwd: root, point: "agent-question", inputs: { "ask.id": "req-3" }, candidates: room }))).toBe("answer-field-unsupported");
    } finally {
      writeFileSync(schemaFile, original);
    }
  });
});

describe("the points file in check and on read (#2738)", () => {
  test("a changed point warns on its answers, and an invalid points file is WSP116 and a points-invalid source", async () => {
    const file = join(root, "decisions", "points.json");
    const changed = JSON.parse(readFileSync(file, "utf-8"));
    changed.points["slice-tier"].title = "Which builder builds this work item";
    writeFileSync(file, JSON.stringify(changed, null, 2));
    const doc = await workspacePoints({ cwd: root });
    read.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const slice = doc.questions.filter((q) => q.point === "slice-tier");
    expect(slice.every((q) => q.current === false && q.warnings.some((w) => w.code === "answer-point-changed"))).toBe(true);
    expect((await runDeclarationChecks(root)).diagnostics.filter((d) => d.ruleId === "WSP116")).toEqual([]);

    changed.points["slice-tier"].deciders.pop();
    writeFileSync(file, JSON.stringify(changed, null, 2));
    const report = await runDeclarationChecks(root);
    expect(report.diagnostics.filter((d) => d.ruleId === "WSP116").map((d) => d.message)).toEqual([
      "the workspace declares the answer kind answers/answer.kind.mjs, whose points file decisions/points.json has points.slice-tier.deciders, which must end in a quorum: when no table row or model answers, people do",
    ]);
    expect(report.ok).toBe(false);
    const broken = await workspacePoints({ cwd: root });
    read.expectValid(broken);
    if ("error" in broken) throw new Error(broken.error.message);
    expect(broken.sources[0].reason?.code).toBe("points-invalid");
    expect(refused(await askPoint({ cwd: root, point: "slice-tier", inputs: big }))).toBe("points-invalid");
  });
});
