/**
 * chant's commit trailers (#3149): the vocabulary, and the joins `graph
 * --intent` and `graph --intent --record` make through it.
 *
 * - c0 adds the workspace and s-001, decided, which constrains path:app.
 * - c1 adds W-001, open, implementing s-001.
 * - c2 edits app/main.js with Chant-Record: work:W-001, Chant-Run and Chant-Agent.
 * - c3 edits app/main.js with only a Chant-Lease, whose token the lease
 *   history of W-001 on chant/lifecycle names.
 * - c4 edits app/main.js with Chant-Record: decision:s-001.
 * - c5 edits app/main.js with nothing to account for it.
 * - c6 edits app/main.js with a Chant-Record no kind has, and the apply trailers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { writeBlobToPath } from "../lifecycle/git";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { intentGraph, type CommitNode, type IntentDocument } from "./intent";
import { intentRecord, type IntentRecordDocument } from "./intent-record";
import intentRecordSchema from "./intent-record.schema.json";
import intentSchema from "./intent.schema.json";
import { parseFrontMatter } from "./records";
import { formatChantTrailers, parseRecordRef, readChantTrailers } from "./trailers";

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
  const data = { schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: [], evidence: [], opened_on: "2026-10-01", supersedes: [], ...fields };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n\nWhat the work is.\n`;
}

const TOKEN = "3f0c7d2e-lease-token";
const TIP = "a".repeat(40);
let root: string;
const sha: Record<string, string> = {};
let tick = 0;

function commit(message: string[]): string {
  const date = `2026-10-01T12:00:${String(tick++).padStart(2, "0")}Z`;
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

const KINDS = ["decisions/decision.kind.mjs", "work/work.kind.mjs"];

beforeAll(async () => {
  root = repo({
    "chant.workspace.json": JSON.stringify({ name: "trailers", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "the app" }] }),
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "app/main.js": "export const n = 0;\n",
    "decisions/s-001-app.md": decision("s-001", { constrains: ["path:app"] }),
  });
  sha.c0 = commit(["the workspace, and s-001"]);
  writeFiles(root, { "work/W-001-app.md": work("W-001", { implements: ["s-001"] }) });
  sha.c1 = commit(["W-001"]);
  writeFiles(root, { "app/main.js": "export const n = 1;\n" });
  sha.c2 = commit(["one", formatChantTrailers({ agent: "factory", run: "r-0001", records: ["work:W-001"] }).join("\n")]);
  writeFiles(root, { "app/main.js": "export const n = 2;\n" });
  sha.c3 = commit(["two", `Chant-Lease: ${TOKEN}`]);
  writeFiles(root, { "app/main.js": "export const n = 3;\n" });
  sha.c4 = commit(["three", "Chant-Record: decision:s-001"]);
  writeFiles(root, { "app/main.js": "export const n = 4;\n" });
  sha.c5 = commit(["four"]);
  writeFiles(root, { "app/main.js": "export const n = 5;\n" });
  sha.c6 = commit(["five", formatChantTrailers({ records: [{ kind: "contract", id: "C-001" }], applied: { by: "alice", at: "2026-10-01T12:00:06Z", commit: TIP } }).join("\n")]);
  const line = { version: 1, event: "claim", item: "W-001", holder: "factory", by: "factory", token: TOKEN, acquiredAt: "2026-10-01T12:00:00Z", expiresAt: "2026-10-01T12:10:00Z", timestamp: "2026-10-01T12:00:00Z" };
  await writeBlobToPath("_leases", "W-001.jsonl", JSON.stringify(line), "Work lease claim: W-001", { cwd: root });
});
afterAll(cleanScratch);

describe("the trailer vocabulary", () => {
  test("formats in a fixed order and reads back what it wrote", () => {
    const lines = formatChantTrailers({ applied: { by: "bob", commit: TIP }, records: ["work:W-1", { kind: "decision", id: "ws-075" }], run: "r-1", lease: "tok", agent: "factory" });
    expect(lines).toEqual(["Chant-Agent: factory", "Chant-Lease: tok", "Chant-Run: r-1", "Chant-Record: work:W-1", "Chant-Record: decision:ws-075", "Chant-Applied-By: bob", `Chant-Applied-Commit: ${TIP}`]);
    const trailers: Record<string, string[]> = {};
    for (const l of lines) (trailers[l.slice(0, l.indexOf(":"))] ??= []).push(l.slice(l.indexOf(":") + 1).trim());
    expect(readChantTrailers(trailers)).toEqual({
      agent: "factory",
      lease: "tok",
      run: "r-1",
      records: [
        { kind: "work", id: "W-1" },
        { kind: "decision", id: "ws-075" },
      ],
      applied: { by: "bob", at: null, commit: TIP },
    });
  });

  test("refuses a value git would read differently", () => {
    expect(() => formatChantTrailers({ run: "a\nb" })).toThrow(/one line/);
    expect(() => formatChantTrailers({ records: ["W-1"] })).toThrow(/<kind>:<id>/);
    expect(() => formatChantTrailers({ applied: { by: "x", commit: "abc" } })).toThrow(/full commit id/);
  });

  test("reads keys without case and skips malformed record refs", () => {
    expect(parseRecordRef("Work:W-1")).toBeUndefined();
    const t = readChantTrailers({ "chant-record": ["work:W-1", "nonsense", "work:W-1"], "CHANT-RUN": ["r-9"] });
    expect(t.records).toEqual([{ kind: "work", id: "W-1" }]);
    expect(t.run).toBe("r-9");
    expect(t.applied).toBeNull();
  });
});

const intentContract = contract(intentSchema);
const recordContract = contract(intentRecordSchema);

async function region(): Promise<Exclude<IntentDocument, { error: unknown }>> {
  const { doc } = await intentGraph({ cwd: root, region: "app/main.js", kinds: KINDS.map((k) => join(root, k)) });
  intentContract.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("graph --intent joins a commit through chant's trailers", () => {
  test("each commit node reports what its trailers name", async () => {
    const doc = await region();
    const commit = (k: string) => doc.nodes.find((n) => n.id === `commit:${sha[k]}`) as CommitNode;
    expect(commit("c2").joins).toEqual({ agent: "factory", lease: null, run: "r-0001", records: [{ kind: "work", id: "W-001", node: "record:work/W-001" }], applied: null });
    expect(commit("c3").joins.lease).toEqual({ token: TOKEN, item: "W-001" });
    expect(commit("c4").joins.records).toEqual([{ kind: "decision", id: "s-001", node: "record:decision/s-001" }]);
    expect(commit("c5").joins).toEqual({ agent: null, lease: null, run: null, records: [], applied: null });
    expect(commit("c6").joins.records).toEqual([{ kind: "contract", id: "C-001", node: null }]);
    expect(commit("c6").joins.applied).toEqual({ by: "alice", at: "2026-10-01T12:00:06Z", commit: TIP });
  });

  test("a carried record makes the commit the decision's own work", async () => {
    const doc = await region();
    const state = (k: string) => (doc.nodes.find((n) => n.id === `commit:${sha[k]}`) as CommitNode).state;
    expect(state("c2")).toBe("decided");
    expect(state("c3")).toBe("decided");
    expect(state("c4")).toBe("decided");
    expect(state("c5")).toBe("decided-by-window");
    expect(state("c6")).toBe("decided-by-window");
    const carries = doc.edges.filter((e) => e.kind === "carries").map((e) => `${e.from} ${e.to}`);
    // Newest first, as the history lists the commits.
    expect(carries).toEqual([`commit:${sha.c4} record:decision/s-001`, `commit:${sha.c3} record:work/W-001`, `commit:${sha.c2} record:work/W-001`]);
    expect(doc.nodes.some((n) => n.id === "record:work/W-001" && n.kind === "work")).toBe(true);
  });

  test("graph --intent --record buckets the same commits as own", async () => {
    const { doc } = await intentRecord({ cwd: root, record: "s-001", kinds: KINDS.map((k) => join(root, k)) });
    recordContract.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const bucket = (k: string) => (doc as Exclude<IntentRecordDocument, { error: unknown }>).commits.find((c) => c.sha === sha[k])?.bucket;
    expect([bucket("c2"), bucket("c3"), bucket("c4"), bucket("c5")]).toEqual(["own", "own", "own", "worked"]);
    expect(doc.commits.find((c) => c.sha === sha.c3)?.joins.lease).toEqual({ token: TOKEN, item: "W-001" });
  });
});
