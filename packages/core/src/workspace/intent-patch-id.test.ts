/**
 * Joining a commit to its agent run by patch-id when the trailer is gone (#3036).
 *
 * - app/server.ts; s-001 (path:app/server.ts) is decided and W-001 implements it.
 * - On a side branch, run A (on W-001) records c1, which carries no trailer.
 *   main cherry-picks it as p1: a new sha, the same patch-id.
 * - Run B records b1 on the side branch; main then commits the same change
 *   as p2 with `Chant-Run: run-c`: a trailer join, and content that matches
 *   another run's recorded commit.
 * - Run D records d1 and d2 on the side branch; main squashes them into one
 *   commit, sq, whose patch-id is neither's.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { intentGraph, type IntentDocument } from "./intent";
import { formatIntent } from "./intent-cli";
import { intentRecord } from "./intent-record";
import intentRecordSchema from "./intent-record.schema.json";
import intentSchema from "./intent.schema.json";
import { parseFrontMatter } from "./records";
import { runsWrite, workspaceRuns } from "./runs-cli";
import runsSchema from "./runs.schema.json";

const REF = join(REPO, "reference-workspace");
const BASE = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "decisions", "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();
const decision = (id: string, fields: Record<string, unknown>) => `---\n${JSON.stringify({ ...BASE, id, title: `Decision ${id}`, state: "decided", supersedes: [], evidence: [], reviews: [], ...fields }, null, 2)}\n---\n\n# ${id}\n`;
const work = (id: string, fields: Record<string, unknown>) =>
  `---\n${JSON.stringify({ schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: [], evidence: [], opened_on: "2026-10-01", supersedes: [], ...fields }, null, 2)}\n---\n\n# ${id}\n\nWhat the work is.\n`;

const LINES = ["// The app server.", "export const a = 0;", "export const b = 0;", "export const c = 0;", "export const d = 0;", "export const e = 0;"];
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const edit = (lines: string[], at: number, to: string) => lines.map((l, i) => (i === at - 1 ? to : l));

type Doc = Exclude<IntentDocument, { error: unknown }>;

let root: string;
const sha: Record<string, string> = {};

function commit(message: string[]): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", ...message.flatMap((m) => ["-m", m]));
  return git(root, "rev-parse", "HEAD");
}
async function record(fields: object): Promise<void> {
  const doc = await runsWrite({ verb: "record", fields: JSON.stringify(fields), cwd: root });
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
}
async function walk(region: string): Promise<Doc> {
  const { doc } = await intentGraph({ cwd: root, region });
  contract(intentSchema).expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

beforeAll(async () => {
  root = repo({
    "chant.workspace.json": JSON.stringify({ name: "patch-id", schema: 1, records: [{ kind: "decisions/decision.kind.mjs" }, { kind: "work/work.kind.mjs" }], members: [{ name: "app", dir: "app", kind: "other", because: "the app" }] }),
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "app/server.ts": text(LINES),
    "decisions/s-001-server.md": decision("s-001", { constrains: ["path:app/server.ts"] }),
    "work/W-001-server.md": work("W-001", { implements: ["s-001"] }),
  });
  sha.c0 = commit(["the workspace"]);
  const main = git(root, "rev-parse", "--abbrev-ref", "HEAD");

  // The side branch, where the runs made their commits.
  git(root, "checkout", "-q", "-b", "side");
  writeFiles(root, { "app/server.ts": text(edit(LINES, 2, "export const a = 1;")) });
  sha.c1 = commit(["a is 1"]);
  writeFiles(root, { "app/server.ts": text(edit(edit(LINES, 2, "export const a = 1;"), 3, "export const b = 1;")) });
  sha.b1 = commit(["b is 1"]);
  git(root, "checkout", "-q", "-b", "squashed", sha.c0);
  writeFiles(root, { "app/server.ts": text(edit(LINES, 5, "export const d = 1;")) });
  sha.d1 = commit(["d is 1"]);
  writeFiles(root, { "app/server.ts": text(edit(edit(LINES, 5, "export const d = 1;"), 6, "export const e = 1;")) });
  sha.d2 = commit(["e is 1"]);
  git(root, "checkout", "-q", main);

  await record({ id: "run-a", harness: "claude-code", model: "claude-opus-5-5", unit: "W-001", startedAt: "2026-10-01T10:00:00Z", commits: [{ sha: sha.c1, hunks: [{ path: "app/server.ts", start: 2, end: 2 }] }] });
  await record({ id: "run-b", harness: "claude-code", startedAt: "2026-10-01T11:00:00Z", commits: [sha.b1] });
  await record({ id: "run-c", harness: "other", startedAt: "2026-10-01T11:30:00Z" });
  await record({ id: "run-d", harness: "claude-code", startedAt: "2026-10-01T12:00:00Z", commits: [sha.d1, sha.d2] });

  // main: a cherry-pick that keeps no trailer, a commit whose trailer names another run, and a squash.
  git(root, "cherry-pick", sha.c1);
  sha.p1 = git(root, "rev-parse", "HEAD");
  writeFiles(root, { "app/server.ts": text(edit(edit(LINES, 2, "export const a = 1;"), 3, "export const b = 1;")) });
  sha.p2 = commit(["b is 1, again", "Chant-Run: run-c"]);
  git(root, "merge", "--squash", "-q", "squashed");
  sha.sq = commit(["d and e (#7)"]);
}, 60_000);
afterAll(cleanScratch);

describe("graph --intent joins by patch-id when the trailer is gone", () => {
  test("a cherry-pick of a recorded commit joins its run by content", async () => {
    const doc = await walk("app/server.ts:2");
    expect(sha.p1).not.toBe(sha.c1);
    expect(doc.edges.filter((e) => e.kind === "made-by" && e.from === `commit:${sha.p1}`)).toEqual([{ kind: "made-by", from: `commit:${sha.p1}`, to: "run:run-a", joinedBy: ["patch-id"], recordedAs: sha.c1 }]);
    // The run's work item is carried as by any join, so the commit is s-001's own work.
    expect(doc.edges).toContainEqual({ kind: "carries", from: `commit:${sha.p1}`, to: "record:work/W-001" });
    expect(doc.edges).toContainEqual({ kind: "within", from: `commit:${sha.p1}`, to: "record:decision/s-001", state: "decided" });
    // The why block marks the span and the run as joined by content. The recorded hunks are
    // line numbers in the recorded commit, so a content join is not narrowed by them.
    expect(doc.why.blame).toEqual([{ start: 2, end: 2, commit: `commit:${sha.p1}`, sha: sha.p1, runs: ["run:run-a"], narrowedBy: null, joinedBy: ["patch-id"] }]);
    expect(doc.why.runs).toEqual([{ run: "run:run-a", lines: 1, commits: [`commit:${sha.p1}`], unit: { id: "W-001", kind: null, node: "record:work/W-001" }, decisions: ["record:decision/s-001"], joinedBy: ["patch-id"] }]);
    expect(doc.why.decisions[0]).toMatchObject({ decision: "record:decision/s-001", relevance: "carried", lines: 1 });
    expect(formatIntent(doc)).toContain(`run-a: claude-code/claude-opus-5-5, unpriced; joined by content, as ${sha.c1.slice(0, 8)}`);
    expect(formatIntent(doc)).toContain("(joined by content)");
  });

  test("a trailer join is never overridden, and content that matches another run is a finding", async () => {
    const doc = await walk("app/server.ts:3");
    expect(doc.edges.filter((e) => e.kind === "made-by" && e.from === `commit:${sha.p2}`)).toEqual([{ kind: "made-by", from: `commit:${sha.p2}`, to: "run:run-c", joinedBy: ["trailer"] }]);
    const conflict = doc.nodes.find((n) => n.kind === "finding" && n.code === "intent-commit-join-conflict");
    expect(conflict).toMatchObject({ concerns: [`commit:${sha.p2}`, "run:run-c"] });
    expect(conflict && "message" in conflict ? conflict.message : "").toContain(`run-b (${sha.b1.slice(0, 8)})`);
  });

  test("a squash of several commits has a patch-id of its own and doesn't join by content", async () => {
    const doc = await walk("app/server.ts:5-6");
    expect(doc.edges.filter((e) => e.kind === "made-by" && e.from === `commit:${sha.sq}`)).toEqual([]);
    expect(doc.why.gaps.map((g) => g.code)).toContain("intent-why-no-run");
  });

  test("graph --intent --record lists the content join on the commit", async () => {
    const { doc } = await intentRecord({ cwd: root, record: "s-001" });
    contract(intentRecordSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.commits.find((c) => c.sha === sha.p1)?.runs).toEqual([
      { id: "run-a", recorded: true, state: "ended", harness: "claude-code", model: "claude-opus-5-5", provider: null, by: null, agent: null, unit: "W-001", joinedBy: ["patch-id"], recordedAs: sha.c1 },
    ]);
  });
});

describe("runs --json joins by patch-id", () => {
  test("a run lists the rewritten commit after the one it recorded, with no hunks", async () => {
    const doc = await workspaceRuns({ cwd: root });
    contract(runsSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const byId = new Map(doc.runs.map((r) => [r.id, r]));
    const a = byId.get("run-a")!;
    expect(a.commits).toEqual([
      { sha: sha.c1, patchId: expect.stringMatching(/^[0-9a-f]{40}$/), joinedBy: ["record"], hunks: [{ path: "app/server.ts", start: 2, end: 2 }] },
      { sha: sha.p1, patchId: a.commits[0].patchId, joinedBy: ["patch-id"], hunks: null, recordedAs: sha.c1 },
    ]);
    // p2 carries Chant-Run: run-c, so it joins run C by trailer and run B not at all.
    expect(byId.get("run-b")!.commits.map((c) => c.sha)).toEqual([sha.b1]);
    expect(byId.get("run-c")!.commits).toEqual([{ sha: sha.p2, patchId: expect.any(String), joinedBy: ["trailer"], hunks: null }]);
    // The squash joins neither of run D's commits.
    expect(byId.get("run-d")!.commits.map((c) => c.sha)).toEqual([sha.d1, sha.d2]);
  });
});
