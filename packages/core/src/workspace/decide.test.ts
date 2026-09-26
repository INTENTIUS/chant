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
import { answerPoint, askPoint, type PointsWriteDocument } from "./decide";
import pointAnswerSchema from "./point-answer.schema.json";
import { workspacePoints } from "./points-cli";
import pointsSchema from "./points.schema.json";
import pointsWriteSchema from "./points-write.schema.json";
import type { ModelAsk, WireAnswer } from "./points";
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
    expect(listed.points.map((p) => p.name)).toEqual(["slice-tier", "ship-skip", "finding-triage", "needs-a-decision", "needs-decision"]);
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
