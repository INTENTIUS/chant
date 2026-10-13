/**
 * The commit that decided a record, and the intent walk for one record, on a
 * workspace shaped like the studio's: a root member, a smoke member with a
 * member nested in it, a docs member, decisions that constrain a member and a
 * file at once, a work item, and a plugin that joins commits to units.
 *
 * - c0 adds the workspace, smoke/run.sh, docs/claims.md and s-001, proposed,
 *   which constrains member:smoke and path:docs/claims.md, and s-004,
 *   proposed, which constrains the root member.
 * - c1 edits docs/claims.md while s-001 is proposed.
 * - c2 decides s-001: its window opens here.
 * - c3 edits smoke/run.sh from unit U-0001, whose record names s-001: own work.
 * - c4 adds W-001, open and implementing s-001, and edits smoke/lib.sh: worked.
 * - c5 closes W-001 and adds s-002, decided, which constrains path:docs.
 * - c6 edits docs/claims.md: inside s-002's window too.
 * - c7 edits README.md, in the root member: outside s-001's region.
 * - c8 edits smoke/run.sh with nothing to account for it.
 * - c9 adds s-003, which supersedes s-001: s-001's window closes here.
 * - c10 edits smoke/run.sh after the window.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { intentGraph, type CommitNode, type DecisionNode } from "./intent";
import { formatIntentRecord } from "./intent-cli";
import { intentRecord, type IntentRecordDocument } from "./intent-record";
import intentRecordSchema from "./intent-record.schema.json";
import intentSchema from "./intent.schema.json";
import { parseFrontMatter } from "./records";
import { queryRecords } from "./records-cli";
import recordsSchema from "./records.schema.json";

const REF = join(REPO, "reference-workspace");
const BASE = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "decisions", "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

function decision(id: string, fields: Record<string, unknown>): string {
  const data = { ...BASE, id, title: `Decision ${id}`, state: "decided", supersedes: [], evidence: [], reviews: [], ...fields };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

function work(id: string, fields: Record<string, unknown>): string {
  const data = { schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: [], evidence: [], opened_on: "2026-09-24", supersedes: [], ...fields };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n\nWhat the work is.\n`;
}

const PLUGIN = `
export function commitJoins(commit, context) {
  const id = commit.trailers["Unit"]?.[0];
  if (!id) return undefined;
  const unit = JSON.parse(context.read(\`units/\${id}.json\`));
  return { unit: { id, decisions: unit.decisions }, contract: { id: unit.contract } };
}
`;

const S001 = { constrains: ["member:smoke", "path:docs/claims.md"] };

let root: string;
const sha: Record<string, string> = {};
let tick = 0;

function commit(message: string[]): string {
  // One second apart, so commit dates order the history.
  const date = `2026-09-26T12:00:${String(tick++).padStart(2, "0")}Z`;
  process.env.GIT_AUTHOR_DATE = date;
  process.env.GIT_COMMITTER_DATE = date;
  try {
    git(root, "add", "-A");
    git(root, "commit", "-q", ...message.flatMap((m) => ["-m", m]));
  } finally {
    delete process.env.GIT_AUTHOR_DATE;
    delete process.env.GIT_COMMITTER_DATE;
  }
  return git(root, "rev-parse", "HEAD");
}

const KINDS = ["decisions/decision.kind.mjs", "work/work.kind.mjs", "plugins/units.kind.mjs"];

beforeAll(() => {
  root = repo({
    "chant.workspace.json": JSON.stringify({
      name: "studio",
      schema: 1,
      members: [
        { name: "studio", dir: ".", kind: "other", because: "the repo itself" },
        { name: "smoke", dir: "smoke", kind: "other", because: "the smoke test" },
        { name: "docs", dir: "docs", kind: "other", because: "prose" },
      ],
    }),
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "plugins/units.kind.mjs": PLUGIN,
    "units/U-0001.json": JSON.stringify({ contract: "C-001", decisions: ["s-001"] }),
    "README.md": "The studio.\n",
    "smoke/run.sh": "echo run\n",
    "docs/claims.md": "# Claims\n",
    "decisions/s-001-smoke.md": decision("s-001", { ...S001, state: "proposed" }),
    "decisions/s-004-root.md": decision("s-004", { constrains: ["member:studio"], state: "proposed" }),
  });
  sha.c0 = commit(["the workspace, and s-001 proposed"]);
  writeFiles(root, { "docs/claims.md": "# Claims\n\nOne.\n" });
  sha.c1 = commit(["a claim while s-001 is proposed"]);
  writeFiles(root, { "decisions/s-001-smoke.md": decision("s-001", S001) });
  sha.c2 = commit(["decide s-001"]);
  writeFiles(root, { "smoke/run.sh": "echo run twice\n" });
  sha.c3 = commit(["run twice", "Unit: U-0001"]);
  writeFiles(root, { "work/W-001-lib.md": work("W-001", { implements: ["s-001"] }), "smoke/lib.sh": "echo lib\n" });
  sha.c4 = commit(["W-001 and the lib"]);
  writeFiles(root, {
    "work/W-001-lib.md": work("W-001", { implements: ["s-001"], state: "done", closed_on: "2026-09-26", evidence: [{ title: "The run", url: "https://example.com/run" }] }),
    "decisions/s-002-docs.md": decision("s-002", { constrains: ["path:docs"] }),
  });
  sha.c5 = commit(["W-001 done, and s-002 for the docs"]);
  writeFiles(root, { "docs/claims.md": "# Claims\n\nOne.\nTwo.\n" });
  sha.c6 = commit(["a second claim"]);
  writeFiles(root, { "README.md": "The studio, again.\n" });
  sha.c7 = commit(["the readme"]);
  writeFiles(root, { "smoke/run.sh": "echo run three times\n" });
  sha.c8 = commit(["run three times"]);
  writeFiles(root, { "decisions/s-003-smoke.md": decision("s-003", { ...S001, supersedes: [{ decision: "s-001" }] }) });
  sha.c9 = commit(["s-003 supersedes s-001"]);
  writeFiles(root, { "smoke/run.sh": "echo run four times\n" });
  sha.c10 = commit(["run four times"]);
});
afterAll(cleanScratch);

const recordContract = contract(intentRecordSchema);
type RecordResult = Exclude<IntentRecordDocument, { error: unknown }>;

async function walkRecord(record: string, options: { kinds?: string[]; at?: string } = {}): Promise<RecordResult> {
  const { doc } = await intentRecord({ cwd: root, record, at: options.at, kinds: (options.kinds ?? KINDS).map((k) => join(root, k)) });
  recordContract.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("the commit that decided a record", () => {
  test("records --json names it: the commit that moved the record into an approved state, not the one that added it", async () => {
    const doc = await queryRecords({ kind: join(root, "decisions/decision.kind.mjs"), cwd: root });
    contract(recordsSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const decided = Object.fromEntries(doc.records.map((r) => [r.id, r.decidedIn?.sha ?? null]));
    expect(decided).toEqual({ "s-001": sha.c2, "s-002": sha.c5, "s-003": sha.c9, "s-004": null });
    expect(doc.records.find((r) => r.id === "s-001")!.decidedIn).toEqual({ sha: sha.c2, date: "2026-09-26T12:00:02Z", subject: "decide s-001" });
  });

  test("a proposed record, or one read before it was decided, has none; a work kind carries no decidedIn", async () => {
    const before = await queryRecords({ kind: join(root, "decisions/decision.kind.mjs"), cwd: root, at: sha.c1 });
    if ("error" in before) throw new Error(before.error.message);
    expect(before.records.map((r) => [r.id, r.decidedIn])).toEqual([
      ["s-001", null],
      ["s-004", null],
    ]);
    const w = await queryRecords({ kind: join(root, "work/work.kind.mjs"), cwd: root });
    if ("error" in w) throw new Error(w.error.message);
    expect(w.records.every((r) => !("decidedIn" in r))).toBe(true);
  });

  test("graph --intent carries it on the decision node, and the window opens there: the edit made while s-001 was proposed is outside it", async () => {
    const { doc } = await intentGraph({ cwd: root, region: "docs/claims.md", kinds: KINDS.map((k) => join(root, k)) });
    contract(intentSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const s001 = doc.nodes.find((n): n is DecisionNode => n.kind === "decision" && n.record === "s-001")!;
    expect(s001.decidedIn).toEqual({ sha: sha.c2, date: "2026-09-26T12:00:02Z", subject: "decide s-001" });
    const state = (s: string) => doc.nodes.find((n): n is CommitNode => n.kind === "commit" && n.sha === s)!.state;
    expect(state(sha.c1)).toBe("undecided");
    expect(state(sha.c6)).toBe("decided-by-window");
    expect(doc.edges.filter((e) => e.kind === "within" && e.from === `commit:${sha.c6}`).map((e) => e.to)).toEqual(["record:decision/s-001", "record:decision/s-002"]);
  });
});

describe("graph --intent --record", () => {
  test("walks every path and member entry once, keeps the commits in the window, and buckets each against the record", async () => {
    const doc = await walkRecord("s-001");
    expect(doc.record).toEqual({
      id: "record:decision/s-001",
      recordKind: "decision",
      record: "s-001",
      path: "decisions/s-001-smoke.md",
      title: "Decision s-001",
      state: "decided",
      supersededBy: "s-003",
      decidedIn: { sha: sha.c2, date: "2026-09-26T12:00:02Z", subject: "decide s-001" },
      constrains: [
        { entry: "member:smoke", granularity: "member", path: "smoke", exists: true, walked: true },
        { entry: "path:docs/claims.md", granularity: "path", path: "docs/claims.md", exists: true, walked: true },
      ],
    });
    expect(doc.window).toEqual({ from: sha.c2, until: sha.c9 });
    expect(doc.commits.map((c) => [c.sha, c.bucket, c.files, c.entries])).toEqual([
      [sha.c8, "unexplained", ["smoke/run.sh"], ["member:smoke"]],
      [sha.c6, "within-other", ["docs/claims.md"], ["path:docs/claims.md"]],
      [sha.c4, "worked", ["smoke/lib.sh"], ["member:smoke"]],
      [sha.c3, "own", ["smoke/run.sh"], ["member:smoke"]],
    ]);
    const by = Object.fromEntries(doc.commits.map((c) => [c.sha, { unit: c.unit, workedBy: c.workedBy, alsoWithin: c.alsoWithin }]));
    expect(by[sha.c3]).toEqual({ unit: "U-0001", workedBy: [], alsoWithin: [] });
    expect(by[sha.c4]).toEqual({ unit: null, workedBy: [{ recordKind: "work", record: "W-001", state: "done" }], alsoWithin: [] });
    expect(by[sha.c6]).toEqual({ unit: null, workedBy: [], alsoWithin: [{ recordKind: "decision", record: "s-002", state: "decided" }] });
    // c0, c1 and c10 changed the region outside the window; c7 changed only the root member.
    expect(doc.counts).toEqual({ commits: 4, own: 1, worked: 1, withinOther: 1, unexplained: 1, outsideWindow: 3 });
    expect(doc.reasons).toEqual([]);
  });

  test("the text walk prints the record, its window, each commit with its bucket, and the counts", async () => {
    const text = formatIntentRecord(await walkRecord("decision/s-001"));
    expect(text.split("\n")[0]).toBe("record    s-001 decided, superseded by s-003: Decision s-001");
    expect(text).toContain(`window    from ${sha.c2.slice(0, 8)} until ${sha.c9.slice(0, 8)}; decided in ${sha.c2.slice(0, 8)}`);
    expect(text).toContain(`own          ${sha.c3.slice(0, 8)} 2026-09-26 run twice; unit U-0001; smoke/run.sh`);
    expect(text).toContain(`worked       ${sha.c4.slice(0, 8)} 2026-09-26 W-001 and the lib; worked by W-001; smoke/lib.sh`);
    expect(text).toContain(`within-other ${sha.c6.slice(0, 8)} 2026-09-26 a second claim; within s-002; docs/claims.md`);
    expect(text.split("\n").at(-1)).toBe("4 commits in the window: 1 own, 1 worked, 1 within another record's window, 1 unexplained; 3 outside it");
  });

  test("a current record's window runs to the revision read; --at reads the history as it was", async () => {
    const s003 = await walkRecord("s-003");
    expect(s003.window).toEqual({ from: sha.c9, until: null });
    expect(s003.commits.map((c) => [c.sha, c.bucket])).toEqual([[sha.c10, "unexplained"]]);
    const early = await walkRecord("s-001", { at: sha.c4 });
    expect(early.window).toEqual({ from: sha.c2, until: null });
    expect(early.commits.map((c) => [c.sha, c.bucket])).toEqual([
      [sha.c4, "worked"],
      [sha.c3, "own"],
    ]);
  });

  test("the root member's history leaves out the members inside it, and a proposed record's window opens where it was added", async () => {
    const doc = await walkRecord("s-004");
    expect(doc.record.decidedIn).toBeNull();
    expect(doc.window).toEqual({ from: sha.c0, until: null });
    expect(doc.commits.map((c) => c.sha)).toEqual([sha.c9, sha.c7, sha.c5, sha.c4, sha.c2, sha.c0]);
    expect(doc.commits.flatMap((c) => c.files).filter((f) => f.startsWith("smoke/") || f.startsWith("docs/"))).toEqual([]);
    expect(doc.commits.find((c) => c.sha === sha.c7)!.files).toEqual(["README.md"]);
  });

  test("without the plugin nothing joins c3 to a unit, so it is unexplained; without the work kind c4 is too", async () => {
    const doc = await walkRecord("s-001", { kinds: ["decisions/decision.kind.mjs"] });
    expect(doc.commits.map((c) => c.bucket)).toEqual(["unexplained", "within-other", "unexplained", "unexplained"]);
    expect(doc.counts).toMatchObject({ own: 0, worked: 0, withinOther: 1, unexplained: 3 });
  });

  test("an id no decision has is intent-record-unknown, and so is a work item's", async () => {
    for (const id of ["s-404", "W-001"]) {
      const { doc, failed } = await intentRecord({ cwd: root, record: id, kinds: KINDS.map((k) => join(root, k)) });
      recordContract.expectValid(doc);
      expect(failed).toBe(true);
      expect("error" in doc && doc.error.code).toBe("intent-record-unknown");
    }
  });
});
