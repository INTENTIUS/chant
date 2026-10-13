/**
 * The agent run record (#3033): `runs start|end|record` append to the run
 * ledger on chant/lifecycle, `runs --json` folds and totals it, and the intent
 * walks link each commit to the run that made it.
 *
 * - The workspace has s-001, decided, constraining path:app, and W-001,
 *   implementing it.
 * - Run A starts on W-001 for alice, makes c1 with its Chant-Run trailer, and
 *   ends with usage, a USD cost and a transcript hashed from a file.
 * - Run B is a chat turn for bob, recorded at once, with usage and no cost.
 * - Run C answered a question on s-001 for carol, in EUR, and lists c2, which
 *   carries no trailer.
 * - Run D starts and never ends.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { intentGraph, type RunNode } from "./intent";
import { intentRecord } from "./intent-record";
import intentRecordSchema from "./intent-record.schema.json";
import intentSchema from "./intent.schema.json";
import { parseFrontMatter } from "./records";
import { runsWrite, workspaceRuns, type RunsDocument, type RunsWriteDocument } from "./runs-cli";
import runsSchema from "./runs.schema.json";
import runsWriteSchema from "./runs-write.schema.json";

const REF = join(REPO, "reference-workspace");
const BASE = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "decisions", "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();
const decision = (id: string, fields: Record<string, unknown>) => `---\n${JSON.stringify({ ...BASE, id, title: `Decision ${id}`, state: "decided", supersedes: [], evidence: [], reviews: [], ...fields }, null, 2)}\n---\n\n# ${id}\n`;
const work = (id: string, fields: Record<string, unknown>) =>
  `---\n${JSON.stringify({ schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: [], evidence: [], opened_on: "2026-10-01", supersedes: [], ...fields }, null, 2)}\n---\n\n# ${id}\n\nWhat the work is.\n`;

const writeContract = contract(runsWriteSchema);
const readContract = contract(runsSchema);
type Written = Exclude<RunsWriteDocument, { error: unknown }>;
type Read = Exclude<RunsDocument, { error: unknown }>;

let root: string;
let transcript: string;
const sha: Record<string, string> = {};
const run: Record<string, string> = {};

async function write(verb: "start" | "end" | "record", fields: object, id?: string): Promise<RunsWriteDocument> {
  const doc = await runsWrite({ verb, id, fields: JSON.stringify(fields), cwd: root });
  writeContract.expectValid(doc);
  return doc;
}
async function written(verb: "start" | "end" | "record", fields: object, id?: string): Promise<Written> {
  const doc = await write(verb, fields, id);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}
async function read(query: Record<string, string> = {}): Promise<Read> {
  const doc = await workspaceRuns({ cwd: root, ...query });
  readContract.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}
function commit(message: string[]): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", ...message.flatMap((m) => ["-m", m]));
  return git(root, "rev-parse", "HEAD");
}

beforeAll(async () => {
  root = repo({
    "chant.workspace.json": JSON.stringify({ name: "runs", schema: 1, records: [{ kind: "decisions/decision.kind.mjs" }, { kind: "work/work.kind.mjs" }], members: [{ name: "app", dir: "app", kind: "other", because: "the app" }] }),
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "app/main.js": "export const n = 0;\n",
    "decisions/s-001-app.md": decision("s-001", { constrains: ["path:app"] }),
    "work/W-001-app.md": work("W-001", { implements: ["s-001"] }),
  });
  sha.c0 = commit(["the workspace"]);
  transcript = join(scratchDir("chant-runs-transcript-"), "session.jsonl");
  writeFileSync(transcript, '{"type":"result"}\n');

  const a = await written("start", { harness: { name: "claude-code", version: "2.1.0" }, model: "claude-opus-5-5", provider: "anthropic", by: "alice", agent: "factory", unit: "W-001", lease: "tok-1", startedAt: "2026-10-01T10:00:00Z" });
  run.a = a.run.id;
  writeFiles(root, { "app/main.js": "export const n = 1;\n" });
  sha.c1 = commit(["one", a.trailer]);
  await written(
    "end",
    {
      endedAt: "2026-10-01T10:05:00Z",
      outcome: "done",
      usage: { turns: 12, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 },
      models: [{ model: "claude-opus-5-5", provider: "anthropic", inputTokens: 1000, outputTokens: 200, cost: { amount: 0.5, currency: "USD", source: "harness:claude-code" } }],
      cost: { amount: 0.5, currency: "USD", source: "harness:claude-code" },
      transcript: { path: transcript, ref: "box:~/.claude/projects/app/session.jsonl" },
    },
    run.a,
  );
  run.b = (await written("record", { id: "chat-0001", harness: "hud-chat", model: "claude-sonnet", by: "bob", startedAt: "2026-10-01T11:00:00Z", endedAt: "2026-10-01T11:00:30Z", usage: { turns: 1, inputTokens: 300, outputTokens: 40 } })).run.id;
  writeFiles(root, { "app/main.js": "export const n = 2;\n" });
  sha.c2 = commit(["two, with no trailer"]);
  run.c = (
    await written("record", {
      harness: "lobby-decide",
      model: "claude-haiku",
      by: "carol",
      records: ["decision:s-001"],
      startedAt: "2026-10-01T12:00:00Z",
      endedAt: "2026-10-01T12:00:02Z",
      usage: { inputTokens: 50, outputTokens: 5 },
      cost: { amount: 0.25, currency: "EUR", source: "lobby:list-2026-09" },
      commits: [sha.c2.slice(0, 10)],
    })
  ).run.id;
  run.d = (await written("start", { harness: "claude-code", by: "alice", unit: "W-001", startedAt: "2026-10-01T13:00:00Z" })).run.id;
});
afterAll(cleanScratch);

describe("writing a run", () => {
  test("a start allocates an id and prints the trailer its commits carry", async () => {
    expect(run.a).toMatch(/^20261001T100000Z-[0-9a-f]{8}$/);
    const doc = await written("start", { harness: "x" });
    expect(doc.trailer).toBe(`Chant-Run: ${doc.run.id}`);
    expect(doc.run.state).toBe("running");
    expect(doc.ledger.path).toBe(`_agent-runs/${doc.run.id}.jsonl`);
    expect(doc.ledger.branch).toBe("chant/lifecycle");
  });

  test("the ledger pins the transcript by hash and never holds it", () => {
    const text = git(root, "show", `chant/lifecycle:_agent-runs/${run.a}.jsonl`);
    const end = JSON.parse(text.split("\n")[1]);
    const sha256 = createHash("sha256").update(readFileSync(transcript)).digest("hex");
    expect(end.transcript).toEqual({ sha256, bytes: 18, ref: "box:~/.claude/projects/app/session.jsonl" });
    expect(text).not.toContain('"type":"result"');
  });

  test("refuses what the ledger can't take, and writes nothing", async () => {
    const tip = git(root, "rev-parse", "chant/lifecycle");
    expect(await write("end", {}, "never-started")).toMatchObject({ error: { code: "run-unknown" } });
    expect(await write("end", { outcome: "done" }, run.a)).toMatchObject({ error: { code: "run-ended" } });
    expect(await write("record", { id: run.b, harness: "x" })).toMatchObject({ error: { code: "run-exists" } });
    expect(await write("record", { harness: "x", transcript: { content: "the whole conversation" } })).toMatchObject({ error: { code: "write-input-invalid" } });
    expect(await write("record", { harness: "x", cost: { amount: 1, currency: "dollars", source: "x" } })).toMatchObject({ error: { code: "write-input-invalid" } });
    expect(await write("record", { harness: "x", commits: ["0123456789abcdef"] })).toMatchObject({ error: { code: "write-input-invalid" } });
    expect(await write("record", { harness: "x", startedAt: "2026-10-02T00:00:00Z", endedAt: "2026-10-01T00:00:00Z" })).toMatchObject({ error: { code: "write-input-invalid" } });
    expect(git(root, "rev-parse", "chant/lifecycle")).toBe(tip);
  });
});

describe("pushing the ledger (#3391)", () => {
  test("with no remote, a write says why it did not push", async () => {
    const doc = await written("record", { harness: "x" });
    expect(doc.ledger.pushed).toBe(false);
    expect(doc.ledger.notPushed).toMatch(/no remote/);
  });

  test("a single-branch, shallow clone pushes every write, not only the first", async () => {
    const remote = join(scratchDir("chant-runs-remote-"), "remote.git");
    git(root, "clone", "-q", "--bare", root, remote);
    const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
    const clone = join(scratchDir("chant-runs-clone-"), "box");
    git(root, "clone", "-q", "--single-branch", "--branch", branch, "--depth", "1", `file://${remote}`, clone);
    git(clone, "config", "user.email", "box@chant.dev");
    git(clone, "config", "user.name", "box");
    // The clone's refspec covers its one branch, so git never tracks chant/lifecycle on its own.
    expect(git(clone, "config", "--get-all", "remote.origin.fetch")).not.toContain("chant/lifecycle");

    const writes: Written[] = [];
    const start = await runsWrite({ verb: "start", fields: JSON.stringify({ harness: "planter", startedAt: "2026-10-02T09:00:00Z" }), cwd: clone });
    writeContract.expectValid(start);
    if ("error" in start) throw new Error(start.error.message);
    writes.push(start);
    for (const doc of [
      await runsWrite({ verb: "end", id: start.run.id, fields: JSON.stringify({ outcome: "done", endedAt: "2026-10-02T09:05:00Z" }), cwd: clone }),
      await runsWrite({ verb: "record", fields: JSON.stringify({ harness: "planter", startedAt: "2026-10-02T10:00:00Z", endedAt: "2026-10-02T10:01:00Z" }), cwd: clone }),
    ]) {
      writeContract.expectValid(doc);
      if ("error" in doc) throw new Error(doc.error.message);
      writes.push(doc);
    }
    for (const w of writes) {
      expect(w.ledger.pushed).toBe(true);
      expect(w.ledger.notPushed).toBeUndefined();
    }
    expect(git(remote, "rev-parse", "chant/lifecycle")).toBe(writes[2].ledger.commit);
  });
});

describe("runs --json", () => {
  test("folds each run and joins its commits by trailer and by its own list", async () => {
    const doc = await read();
    const byId = new Map(doc.runs.map((r) => [r.id, r]));
    const a = byId.get(run.a)!;
    expect(a).toMatchObject({ state: "ended", outcome: "done", by: "alice", agent: "factory", harness: { name: "claude-code", version: "2.1.0" }, model: "claude-opus-5-5", unit: { id: "W-001", kind: null }, lease: "tok-1", decisions: ["decision/s-001"] });
    expect(a.commits).toEqual([{ sha: sha.c1, patchId: expect.stringMatching(/^[0-9a-f]{40}$/), joinedBy: ["trailer"], hunks: null }]);
    const c = byId.get(run.c)!;
    expect(c.commits).toEqual([{ sha: sha.c2, patchId: expect.stringMatching(/^[0-9a-f]{40}$/), joinedBy: ["record"], hunks: null }]);
    expect(c.decisions).toEqual(["decision/s-001"]);
    expect(byId.get(run.d)).toMatchObject({ state: "running", endedAt: null, cost: null, usage: null });
    // Newest first.
    expect(doc.runs.map((r) => r.startedAt)).toEqual([...doc.runs.map((r) => r.startedAt)].sort().reverse());
  });

  test("totals per unit, decision and principal, naming the runs with no cost instead of counting zero", async () => {
    const doc = await read();
    const all = doc.totals.all;
    expect(all.cost).toEqual([
      { currency: "EUR", amount: 0.25 },
      { currency: "USD", amount: 0.5 },
    ]);
    expect(all.unpriced).toEqual(expect.arrayContaining([run.b, run.d]));
    expect(all.unpriced).not.toContain(run.a);
    expect(all.unreported).toContain(run.d);
    expect(all.running).toBeGreaterThanOrEqual(1);
    const w = doc.totals.byUnit.find((u) => u.unit === "W-001")!;
    expect(w).toMatchObject({ runs: 2, running: 1, tokens: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0 }, cost: [{ currency: "USD", amount: 0.5 }], unpriced: [run.d] });
    const d = doc.totals.byDecision.find((x) => x.decision === "decision/s-001")!;
    expect(d.runs).toBe(3);
    expect(d.cost).toEqual([
      { currency: "EUR", amount: 0.25 },
      { currency: "USD", amount: 0.5 },
    ]);
    expect(doc.totals.byPrincipal.find((p) => p.principal === "bob")).toMatchObject({ runs: 1, tokens: { input: 300, output: 40 }, cost: [], unpriced: [run.b] });
  });

  test("filters by unit, decision, principal and revision", async () => {
    expect((await read({ unit: "W-001" })).runs.map((r) => r.id).sort()).toEqual([run.a, run.d].sort());
    expect((await read({ decision: "s-001" })).runs.map((r) => r.id).sort()).toEqual([run.a, run.c, run.d].sort());
    expect((await read({ decision: "decision/s-001" })).runs).toHaveLength(3);
    expect((await read({ by: "carol" })).runs.map((r) => r.id)).toEqual([run.c]);
    const since = await read({ since: sha.c1 });
    expect(since.runs.map((r) => r.id)).toContain(run.c);
    expect(since.filter.since).toBe(sha.c1);
    expect(await workspaceRuns({ cwd: root, since: "no-such-rev" })).toMatchObject({ error: { code: "revision-unknown" } });
  });

  test("a checkout with no ledger reads no runs and says why", async () => {
    const empty = repo({ "chant.workspace.json": JSON.stringify({ name: "empty", schema: 1, members: [] }) }, true);
    const doc = await workspaceRuns({ cwd: empty });
    readContract.expectValid(doc);
    expect(doc).toMatchObject({ runs: [], ledger: { commit: null }, reasons: [{ code: "runs-no-ledger" }] });
  });
});

describe("the intent walks name the run behind each commit", () => {
  test("graph --intent links a commit to its run, with the model", async () => {
    const { doc } = await intentGraph({ cwd: root, region: "app/main.js", kinds: ["decisions/decision.kind.mjs", "work/work.kind.mjs"].map((k) => join(root, k)) });
    contract(intentSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const madeBy = doc.edges.filter((e) => e.kind === "made-by");
    expect(madeBy).toEqual(
      expect.arrayContaining([
        { kind: "made-by", from: `commit:${sha.c1}`, to: `run:${run.a}`, joinedBy: ["trailer"] },
        { kind: "made-by", from: `commit:${sha.c2}`, to: `run:${run.c}`, joinedBy: ["record"] },
      ]),
    );
    const a = doc.nodes.find((n) => n.id === `run:${run.a}`) as RunNode;
    expect(a).toMatchObject({ recorded: true, model: "claude-opus-5-5", by: "alice", unit: "W-001", cost: { amount: 0.5, currency: "USD" } });
  });

  test("a trailer naming a run the ledger lacks is listed as unrecorded", async () => {
    writeFiles(root, { "app/main.js": "export const n = 3;\n" });
    sha.c3 = commit(["three", "Chant-Run: not-in-the-ledger"]);
    const { doc } = await intentGraph({ cwd: root, region: "app/main.js", kinds: [join(root, "decisions/decision.kind.mjs")] });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.nodes.find((n) => n.id === "run:not-in-the-ledger")).toMatchObject({ recorded: false, model: null });
  });

  test("graph --intent --record names each commit's runs", async () => {
    const { doc } = await intentRecord({ cwd: root, record: "s-001", kinds: ["decisions/decision.kind.mjs", "work/work.kind.mjs"].map((k) => join(root, k)) });
    contract(intentRecordSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.commits.find((c) => c.sha === sha.c1)?.runs).toEqual([
      { id: run.a, recorded: true, state: "ended", harness: "claude-code", model: "claude-opus-5-5", provider: "anthropic", by: "alice", agent: "factory", unit: "W-001", joinedBy: ["trailer"] },
    ]);
  });
});
