/**
 * #3147 — the work kind's fields that replace studio's x-factory on work
 * items: a contract link read with the contract's state, a builder tier from
 * the tiers the kind declares, decision-point answers joined by the item's id
 * (from the tree, and from the lifecycle ledger where a steward asked them),
 * the box's intent as a source, an attempt limit, and result.lease.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo } from "./__fixtures__/contract-repo";
import { writeBlobToPath } from "../lifecycle/git";
import { answersLedgerDir } from "./answers-ledger";
import { parseFrontMatter } from "./records";
import { queryRecords } from "./records-cli";
import { newRecord } from "./records-write";
import recordsSchema from "./records.schema.json";

const REF = join(REPO, "reference-workspace");
const ref = (path: string) => readFileSync(join(REF, path), "utf-8");
const records = contract(recordsSchema);

const DECISION = (() => {
  const fm = parseFrontMatter(ref("decisions/ref-001-how-the-app-is-deployed.md"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

function decision(id: string, state = "decided"): string {
  const proposed = state === "proposed";
  const data = { ...DECISION, id, title: `Record ${id}`, state, supersedes: [], evidence: [], constrains: ["member:app"], ...(proposed ? { choice: null, decided_by: null, decided_on: null } : {}) };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

function work(id: string, fields: Record<string, unknown> = {}): string {
  const data = { schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: ["member:app"], evidence: [], opened_on: "2026-10-03", source: { kind: "workspace", member: "app" }, supersedes: [], ...fields };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

/** The reference slice-tier answer, about `item`, under the id `id`. */
function answer(id: string, item: string, extra: Record<string, unknown> = {}): string {
  const fm = parseFrontMatter(ref("answers/slice-tier-01eb5382958d.md"));
  if (!fm.ok) throw new Error(fm.message);
  const data = { ...fm.value, id, constrains: [item], ...extra };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

// The reference work kind, with a contract kind: here the decision kind's shape, kept in contracts/.
const KIND = ref("work/work.kind.mjs").replace(
  '    answers: "../answers/answer.kind.mjs",\n',
  '    answers: "../answers/answer.kind.mjs",\n    contract: { field: "contract", kind: "../contracts/decision.kind.mjs" },\n',
);

let root: string;

beforeAll(async () => {
  expect(KIND).toContain("../contracts/decision.kind.mjs");
  root = repo({
    "chant.workspace.json": JSON.stringify({ name: "box", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "the app" }] }),
    "app/server.mjs": "export const port = 8080;\n",
    "decisions/decision.kind.mjs": ref("decisions/decision.kind.mjs"),
    "decisions/decision.schema.json": ref("decisions/decision.schema.json"),
    "decisions/points.json": ref("decisions/points.json"),
    "decisions/intent-001-what-to-build.md": decision("intent-001"),
    "contracts/decision.kind.mjs": ref("decisions/decision.kind.mjs"),
    "contracts/decision.schema.json": ref("decisions/decision.schema.json"),
    "contracts/con-001-notes.md": decision("con-001"),
    "contracts/con-002-draft.md": decision("con-002", "proposed"),
    "answers/answer.kind.mjs": ref("answers/answer.kind.mjs"),
    "answers/answer.schema.json": ref("answers/answer.schema.json"),
    "answers/slice-tier-0123456789ab.md": answer("slice-tier-0123456789ab", "W-001"),
    "work/work.kind.mjs": KIND,
    "work/work.schema.json": ref("work/work.schema.json"),
    "work/W-001-built.md": work("W-001", { contract: "con-001", tier: "small", max_attempts: 5, result: { lease: "6f0c11aa" } }),
    "work/W-002-draft.md": work("W-002", { contract: "con-002", tier: "huge" }),
    "work/W-003-missing.md": work("W-003", { contract: "con-404" }),
    "work/W-004-plain.md": work("W-004"),
    "work/W-005-intent.md": work("W-005", {
      implements: ["intent-001"],
      source: { intent: { decision: "intent-001", question: "What should the box build?", answer: "A notes app", by: "morgan", at: "2026-10-03T09:00:00Z" } },
    }),
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the box");
  // A question a steward asked in its turn sits on the lifecycle ledger, never in the checkout (#2786).
  await writeBlobToPath(answersLedgerDir("answer"), "understand-0123456789ab.md", answer("understand-0123456789ab", "W-001", { point: "understand", answer: "proceed", answered_by: ["morgan"] }), "ask understand", { cwd: join(root, "answers") });
});
afterAll(cleanScratch);

describe("the work kind's fields (#3147)", () => {
  test("contract links with the contract's state, tier and contract warnings, and answers joined by id from the tree and the ledger", async () => {
    const doc = await queryRecords({ kind: "work/work.kind.mjs", cwd: root });
    records.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.summary).toMatchObject({ total: 5, valid: 5, invalid: 0 });
    const by = Object.fromEntries(doc.records.map((r) => [r.id, r]));
    const codes = (id: string) => by[id].warnings.map((w: { code: string }) => w.code);

    expect(by["W-001"].contract).toEqual({ id: "con-001", state: "decided" });
    expect(codes("W-001")).toEqual([]);
    expect(by["W-002"].contract).toEqual({ id: "con-002", state: "proposed" });
    expect(codes("W-002")).toEqual(["work-contract-undecided", "work-tier-unknown"]);
    expect(by["W-003"].contract).toEqual({ id: "con-404", state: null });
    expect(codes("W-003")).toEqual(["work-contract-unknown"]);
    expect(by["W-004"].contract).toBeNull();

    // The item carries neither answer; the read joins both by its id.
    expect(by["W-001"].answers).toEqual([
      { id: "slice-tier-0123456789ab", point: "slice-tier", state: "answered", answer: "small", answeredBy: [] },
      { id: "understand-0123456789ab", point: "understand", state: "answered", answer: "proceed", answeredBy: ["morgan"] },
    ]);
    expect(by["W-002"].answers).toEqual([]);
    expect(by["W-005"].data).toMatchObject({ source: { intent: { decision: "intent-001", answer: "A notes app", by: "morgan" } } });
  });

  test("at a revision, answers come from that tree only: the ledger is not part of it", async () => {
    const doc = await queryRecords({ kind: "work/work.kind.mjs", cwd: root, at: "HEAD" });
    records.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.records.find((r) => r.id === "W-001")!.answers!.map((a) => a.id)).toEqual(["slice-tier-0123456789ab"]);
  });

  test("the schema keeps only the lease under result, and an intent source needs its decision, answer and who decided", async () => {
    const fields = (over: Record<string, unknown>) =>
      JSON.stringify({ schema: 1, title: "More", state: "open", implements: [], needs: [], constrains: ["member:app"], evidence: [], opened_on: "2026-10-03", source: { kind: "workspace", member: "app" }, supersedes: [], ...over });
    const kind = "work/work.kind.mjs";
    const ok = await newRecord({ kind, fields: fields({ result: { lease: "6f0c" }, max_attempts: 2, tier: "large", contract: "con-001" }), dryRun: true, cwd: root });
    expect("error" in ok ? ok.error : null).toBeNull();
    for (const over of [
      { result: { lease: "6f0c", agent: "builder" } },
      { max_attempts: 0 },
      { source: { intent: { decision: "intent-001", answer: "A notes app" } } },
      { source: { intent: { decision: "intent-001", by: "morgan" } } },
    ]) {
      const doc = await newRecord({ kind, fields: fields(over), dryRun: true, cwd: root });
      expect("error" in doc && doc.error.code, JSON.stringify(over)).toBe("record-schema-invalid");
    }
  });

  test("a kind that lists a tier twice, or names an attempt limit below one, is kind-invalid", async () => {
    for (const [from, to] of [
      ['tiers: ["small", "medium", "large"]', 'tiers: ["small", "small"]'],
      ['max: 3', 'max: 0'],
    ]) {
      const dir = repo({
        "work/work.kind.mjs": ref("work/work.kind.mjs").replace(from, to),
        "work/work.schema.json": ref("work/work.schema.json"),
      });
      const doc = await queryRecords({ kind: "work/work.kind.mjs", cwd: dir });
      expect("error" in doc && doc.error.code, to).toBe("kind-invalid");
    }
  });
});
