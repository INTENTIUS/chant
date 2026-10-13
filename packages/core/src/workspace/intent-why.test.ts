/**
 * From a line or a symbol to the decision and the agent run behind it (#3034).
 *
 * - app/server.ts declares createApp and a class Server with listen and close.
 * - s-001 (path:app/server.ts), s-002 (member:app) and s-003 (path:app) are
 *   decided; W-001 implements s-001.
 * - c1 changes createApp's body, made by run A on W-001 (Chant-Run trailer).
 * - c2 changes listen's and close's bodies; runs B and C both list it, B
 *   with the hunk in listen and C with the hunk in close.
 * - c3 changes the first line; runs D and E both list it, with no hunks.
 * - docs/notes.ts is in no member and no decision covers it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { intentGraph, type IntentDocument, type RegionNode, type RunNode } from "./intent";
import { formatIntent } from "./intent-cli";
import intentSchema from "./intent.schema.json";
import { parseFrontMatter } from "./records";
import { runsWrite, workspaceRuns } from "./runs-cli";
import runsSchema from "./runs.schema.json";
import runsWriteSchema from "./runs-write.schema.json";
import { resolveSymbol } from "./symbols";

const REF = join(REPO, "reference-workspace");
const BASE = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "decisions", "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();
const decision = (id: string, fields: Record<string, unknown>) => `---\n${JSON.stringify({ ...BASE, id, title: `Decision ${id}`, state: "decided", supersedes: [], evidence: [], reviews: [], ...fields }, null, 2)}\n---\n\n# ${id}\n`;
const work = (id: string, fields: Record<string, unknown>) =>
  `---\n${JSON.stringify({ schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: [], evidence: [], opened_on: "2026-10-01", supersedes: [], ...fields }, null, 2)}\n---\n\n# ${id}\n\nWhat the work is.\n`;

const SERVER = [
  "// The app server.",
  "export function createApp() {",
  "  return 0;",
  "}",
  "",
  "export class Server {",
  "  /** Listens. */",
  "  listen(port: number) {",
  "    return port;",
  "  }",
  "",
  "  close() {",
  "    return 0;",
  "  }",
  "}",
];
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const edit = (lines: string[], at: number, to: string) => lines.map((l, i) => (i === at - 1 ? to : l));

const intent = contract(intentSchema);
type Doc = Exclude<IntentDocument, { error: unknown }>;

let root: string;
const sha: Record<string, string> = {};
const run: Record<string, string> = {};

function commit(message: string[]): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", ...message.flatMap((m) => ["-m", m]));
  return git(root, "rev-parse", "HEAD");
}
async function record(fields: object): Promise<string> {
  const doc = await runsWrite({ verb: "record", fields: JSON.stringify(fields), cwd: root });
  contract(runsWriteSchema).expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc.run.id;
}
async function walk(region: string, at?: string): Promise<Doc> {
  const { doc } = await intentGraph({ cwd: root, region, at });
  intent.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

beforeAll(async () => {
  root = repo({
    "chant.workspace.json": JSON.stringify({ name: "why", schema: 1, records: [{ kind: "decisions/decision.kind.mjs" }, { kind: "work/work.kind.mjs" }], members: [{ name: "app", dir: "app", kind: "other", because: "the app" }] }),
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "app/server.ts": text(SERVER),
    "app/tool.py": "def run():\n    return 0\n",
    "app/twice.ts": "class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\n",
    "docs/notes.ts": "export const notes = [];\n",
    "decisions/s-001-server.md": decision("s-001", { constrains: ["path:app/server.ts"] }),
    "decisions/s-002-app.md": decision("s-002", { constrains: ["member:app"] }),
    "decisions/s-003-app-dir.md": decision("s-003", { constrains: ["path:app"] }),
    "work/W-001-server.md": work("W-001", { implements: ["s-001"] }),
  });
  sha.c0 = commit(["the workspace"]);

  run.a = await record({ id: "run-a", harness: "claude-code", model: "claude-opus-5-5", by: "alice", unit: "W-001", instruction: { sha256: "a".repeat(64), excerpt: "Make createApp return 1." }, startedAt: "2026-10-01T10:00:00Z", endedAt: "2026-10-01T10:05:00Z" });
  writeFiles(root, { "app/server.ts": text(edit(SERVER, 3, "  return 1;")) });
  sha.c1 = commit(["createApp returns 1", `Chant-Run: ${run.a}`]);

  const v2 = edit(edit(edit(SERVER, 3, "  return 1;"), 9, "    return port + 1;"), 13, "    return 1;");
  writeFiles(root, { "app/server.ts": text(v2) });
  sha.c2 = commit(["listen and close"]);
  run.b = await record({ id: "run-b", harness: "claude-code", model: "claude-sonnet", startedAt: "2026-10-01T11:00:00Z", commits: [{ sha: sha.c2, hunks: [{ path: "app/server.ts", start: 9, end: 9 }] }] });
  run.c = await record({ id: "run-c", harness: "claude-code", model: "claude-haiku", startedAt: "2026-10-01T11:01:00Z", commits: [{ sha: sha.c2, hunks: [{ path: "app/server.ts", start: 13, end: 13 }] }] });

  writeFiles(root, { "app/server.ts": text(edit(v2, 1, "// The app server, v2.")) });
  sha.c3 = commit(["the header"]);
  run.d = await record({ id: "run-d", harness: "x", startedAt: "2026-10-01T12:00:00Z", commits: [sha.c3] });
  run.e = await record({ id: "run-e", harness: "y", startedAt: "2026-10-01T12:01:00Z", commits: [sha.c3] });
});
afterAll(cleanScratch);

describe("symbols resolve to their current lines", () => {
  test("functions, methods, classes and constants in TypeScript and JavaScript", () => {
    const src = text(SERVER);
    expect(resolveSymbol("a.ts", src, "createApp")).toEqual({ ok: true, declaration: { qualified: "createApp", kind: "function", lines: { start: 2, end: 4 } } });
    expect(resolveSymbol("a.ts", src, "Server")).toMatchObject({ ok: true, declaration: { kind: "class", lines: { start: 6, end: 15 } } });
    // A bare member name finds the one method it names; the doc comment is in its lines.
    expect(resolveSymbol("a.ts", src, "listen")).toEqual({ ok: true, declaration: { qualified: "Server.listen", kind: "method", lines: { start: 7, end: 10 } } });
    expect(resolveSymbol("a.ts", src, "Server.close")).toMatchObject({ ok: true, declaration: { lines: { start: 12, end: 14 } } });
    const js = "/** The handlers. */\nexport const handlers = {\n  get(req) {\n    return 1;\n  },\n};\nmodule.exports = handlers;\n";
    expect(resolveSymbol("h.mjs", js, "handlers")).toMatchObject({ ok: true, declaration: { kind: "variable", lines: { start: 1, end: 6 } } });
    expect(resolveSymbol("h.mjs", js, "handlers.get")).toMatchObject({ ok: true, declaration: { kind: "method", lines: { start: 3, end: 5 } } });
  });

  test("says why when it can't: no resolver, no such symbol, or more than one", () => {
    expect(resolveSymbol("a.py", "def f(): pass\n", "f")).toMatchObject({ ok: false, reason: "unsupported" });
    const unknown = resolveSymbol("a.ts", text(SERVER), "nope");
    expect(unknown).toMatchObject({ ok: false, reason: "unknown", candidates: ["createApp", "Server"] });
    expect(resolveSymbol("t.ts", "class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\n", "run")).toMatchObject({ ok: false, reason: "ambiguous", candidates: ["A.run", "B.run"] });
  });
});

describe("graph --intent path#symbol", () => {
  test("walks the symbol's current lines as a line range", async () => {
    const doc = await walk("app/server.ts#createApp");
    const region = doc.nodes.find((n) => n.id === doc.region) as RegionNode;
    expect(doc.region).toBe("region:app/server.ts#createApp");
    expect(region).toMatchObject({ path: "app/server.ts", lines: { start: 2, end: 4 }, symbol: { name: "createApp", qualified: "createApp", kind: "function" } });
    expect(doc.history.follows).toBe("line-range");
    const commits = doc.nodes.filter((n) => n.kind === "commit").map((n) => (n as { sha: string }).sha);
    expect(commits).toContain(sha.c1);
    expect(commits).not.toContain(sha.c3);
  });

  test("refuses a symbol it can't resolve, with a code for each reason", async () => {
    for (const [region, code] of [
      ["app/server.ts#nope", "intent-symbol-unknown"],
      ["app/tool.py#run", "intent-symbol-unsupported"],
      ["app/twice.ts#run", "intent-symbol-ambiguous"],
      ["app#run", "intent-region-invalid"],
      ["app/missing.ts#run", "intent-region-invalid"],
    ]) {
      const { doc, failed } = await intentGraph({ cwd: root, region });
      intent.expectValid(doc);
      expect(failed).toBe(true);
      expect(doc, region).toMatchObject({ error: { code } });
    }
    const { doc } = await intentGraph({ cwd: root, region: "app/server.ts#nope" });
    expect("error" in doc && doc.error.message).toContain("createApp, Server");
    expect((await walk("app/twice.ts#B.run")).nodes.find((n) => n.kind === "region")).toMatchObject({ lines: { start: 5, end: 5 } });
  });
});

describe("why the region is like this", () => {
  test("names the run that last wrote each line, with its work item, and the decision it carried out first", async () => {
    const doc = await walk("app/server.ts#createApp");
    expect(doc.why.lines).toEqual({ start: 2, end: 4 });
    expect(doc.why.blame).toEqual([
      { start: 2, end: 2, commit: `commit:${sha.c0}`, sha: sha.c0, runs: [], narrowedBy: null, joinedBy: [] },
      { start: 3, end: 3, commit: `commit:${sha.c1}`, sha: sha.c1, runs: ["run:run-a"], narrowedBy: null, joinedBy: ["trailer"] },
      { start: 4, end: 4, commit: `commit:${sha.c0}`, sha: sha.c0, runs: [], narrowedBy: null, joinedBy: [] },
    ]);
    expect(doc.why.runs).toEqual([{ run: "run:run-a", lines: 1, commits: [`commit:${sha.c1}`], unit: { id: "W-001", kind: null, node: "record:work/W-001" }, decisions: ["record:decision/s-001"], joinedBy: ["trailer"] }]);
    expect(doc.why.decisions.map((d) => [d.decision, d.relevance, d.lines])).toEqual([
      ["record:decision/s-001", "carried", 1],
      ["record:decision/s-003", "path", 0],
      ["record:decision/s-002", "member", 0],
    ]);
    expect(doc.why.explained).toBe(true);
    expect(doc.why.gaps).toEqual([]);
    // The run's work item is carried by the commit it made, and the run points at it.
    expect(doc.edges).toEqual(expect.arrayContaining([{ kind: "carries", from: `commit:${sha.c1}`, to: "record:work/W-001" }, { kind: "worked-on", from: "run:run-a", to: "record:work/W-001" }]));
    expect(doc.nodes.find((n) => n.id === "run:run-a") as RunNode).toMatchObject({ instruction: { sha256: "a".repeat(64), excerpt: "Make createApp return 1." }, lease: null });
  });

  test("a run's recorded hunks pick which of the runs sharing a commit wrote the lines", async () => {
    const listen = await walk("app/server.ts#listen");
    expect(listen.why.blame.find((b) => b.sha === sha.c2)).toMatchObject({ start: 9, end: 9, runs: ["run:run-b"], narrowedBy: "hunks" });
    expect(listen.why.runs.map((r) => r.run)).toEqual(["run:run-b"]);
    const close = await walk("app/server.ts#Server.close");
    expect(close.why.blame.find((b) => b.sha === sha.c2)).toMatchObject({ start: 13, end: 13, runs: ["run:run-c"], narrowedBy: "hunks" });
    expect(close.why.gaps.map((g) => g.code)).not.toContain("intent-why-run-ambiguous");
  });

  test("without hunks, a commit several runs made is ambiguous, and says so", async () => {
    const doc = await walk("app/server.ts:1");
    expect(doc.why.blame).toEqual([{ start: 1, end: 1, commit: `commit:${sha.c3}`, sha: sha.c3, runs: ["run:run-d", "run:run-e"], narrowedBy: null, joinedBy: ["record"] }]);
    expect(doc.why.gaps).toEqual([{ code: "intent-why-run-ambiguous", message: expect.any(String), lines: [{ start: 1, end: 1 }] }]);
  });

  test("a whole file is blamed line by line, and runs are ordered by the lines they wrote", async () => {
    const doc = await walk("app/server.ts");
    expect(doc.why.lines).toEqual({ start: 1, end: SERVER.length });
    expect(doc.why.blame.map((b) => [b.start, b.end])[0]).toEqual([1, 1]);
    expect(doc.why.blame[doc.why.blame.length - 1].end).toBe(SERVER.length);
    expect(doc.why.runs.map((r) => r.run).sort()).toEqual(["run:run-a", "run:run-b", "run:run-c", "run:run-d", "run:run-e"]);
  });

  test("lines not committed yet have no commit, and say so", async () => {
    writeFiles(root, { "app/server.ts": text(edit(edit(edit(edit(SERVER, 1, "// The app server, v2."), 3, "  return 2;"), 9, "    return port + 1;"), 13, "    return 1;")) });
    try {
      const doc = await walk("app/server.ts#createApp");
      expect(doc.why.blame.find((b) => b.start === 3)).toMatchObject({ commit: null, sha: null, runs: [] });
      expect(doc.why.gaps.find((g) => g.code === "intent-why-uncommitted")).toMatchObject({ lines: [{ start: 3, end: 3 }] });
      // The revision read is blamed, not the working tree.
      const at = await walk("app/server.ts#createApp", sha.c3);
      expect(at.why.blame.find((b) => b.start === 3)).toMatchObject({ sha: sha.c1, runs: ["run:run-a"] });
    } finally {
      git(root, "checkout", "--", "app/server.ts");
    }
  });

  test("a region nothing accounts for is unexplained, with its gaps", async () => {
    const doc = await walk("docs/notes.ts#notes");
    expect(doc.why.explained).toBe(false);
    expect(doc.why.decisions).toEqual([]);
    expect(doc.why.runs).toEqual([]);
    expect(doc.why.gaps.map((g) => g.code)).toEqual(["intent-why-no-decision", "intent-why-no-run"]);
    expect(formatIntent(doc)).toContain("why       unexplained, lines 1");
  });

  test("a directory is not blamed, and lists every run in the walk", async () => {
    const doc = await walk("app");
    expect(doc.why.lines).toBeNull();
    expect(doc.why.blame).toEqual([]);
    expect(doc.why.runs.map((r) => r.run)).toEqual(["run:run-e", "run:run-d", "run:run-c", "run:run-b", "run:run-a"]);
    expect(doc.why.decisions[0]).toMatchObject({ decision: "record:decision/s-001", relevance: "carried" });
    expect(doc.why.explained).toBe(true);
  });

  test("prints the answer after the walk", async () => {
    const out = formatIntent(await walk("app/server.ts#createApp"));
    expect(out).toContain("region    app/server.ts#createApp (function createApp, lines 2-4)");
    expect(out).toContain("why       explained, lines 2-4");
    expect(out).toContain("  decision  s-001 carried, 1 line");
    expect(out).toContain(`  lines     3 ${sha.c1.slice(0, 8)}; run-a (claude-code/claude-opus-5-5) on W-001`);
  });
});

describe("the run record keeps hunks and the instruction's excerpt", () => {
  test("runs --json lists each commit's hunks, or null", async () => {
    const doc = await workspaceRuns({ cwd: root });
    contract(runsSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const byId = new Map(doc.runs.map((r) => [r.id, r]));
    expect(byId.get("run-b")!.commits).toEqual([{ sha: sha.c2, patchId: expect.any(String), joinedBy: ["record"], hunks: [{ path: "app/server.ts", start: 9, end: 9 }] }]);
    expect(byId.get("run-d")!.commits[0].hunks).toBeNull();
    expect(byId.get("run-a")!.instruction).toEqual({ sha256: "a".repeat(64), bytes: null, ref: null, excerpt: "Make createApp return 1." });
  });

  test("refuses a hunk that isn't one", async () => {
    for (const hunks of [[{ path: "/abs", start: 1, end: 1 }], [{ path: "a", start: 3, end: 2 }], [{ path: "../a", start: 1, end: 1 }], []]) {
      const doc = await runsWrite({ verb: "record", fields: JSON.stringify({ harness: "x", commits: [{ sha: sha.c0, hunks }] }), cwd: root });
      expect(doc).toMatchObject({ error: { code: "write-input-invalid" } });
    }
    const long = await runsWrite({ verb: "record", fields: JSON.stringify({ harness: "x", instruction: { sha256: "b".repeat(64), excerpt: "x".repeat(501) } }), cwd: root });
    expect(long).toMatchObject({ error: { code: "write-input-invalid" } });
  });
});
