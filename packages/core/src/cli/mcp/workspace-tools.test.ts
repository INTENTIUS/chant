/**
 * #2707 — chant serve mcp's workspace tools: served at or inside a declared
 * workspace, reads that return the CLI's documents, and writes that keep the
 * CLI's rules and say they came through MCP in the record's source block
 * (#2708). Run against the workspace the reader conformance suite generates.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createConformanceWorkspace, defaultChantCommand, mcpToolCall, type ConformanceWorkspace } from "../../workspace/conformance";
import { McpServer } from "./server";
import { workspaceReadTools, workspaceWriteTools } from "./workspace-tools";

const KIND = "decisions/decision.kind.mjs";
const chant = defaultChantCommand();

let ws: ConformanceWorkspace;
beforeAll(() => {
  ws = createConformanceWorkspace({ chantCommand: chant });
}, 300_000);
afterAll(() => ws?.dispose());

type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };

function server(cwd = ws.dir): McpServer {
  return new McpServer([], { workspace: { cwd, chantCommand: chant } });
}

let nextId = 1;
async function rpc(s: McpServer, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await s.handleRequest({ jsonrpc: "2.0", id: nextId++, method, params });
  if (res.error) throw new Error(res.error.message);
  return res.result;
}

async function call(s: McpServer, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<Result> {
  return (await rpc(s, "tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as Result;
}

function cli(argv: string[], env: NodeJS.ProcessEnv = {}): unknown {
  let out: string;
  try {
    out = execFileSync(chant[0], [...chant.slice(1), ...argv], { cwd: ws.dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  return JSON.parse(out);
}

/** A proposed decision's fields, with no id, state or source. */
function proposal(title: string): Record<string, unknown> {
  return {
    schema: 1,
    title,
    area: "delivery",
    question: "Where do the app's logs go?",
    options: [
      { id: "a", label: "stdout", how: "The app writes to stdout and the runtime collects it.", tradeoff: "Nothing to configure." },
      { id: "b", label: "a file", how: "The app writes a file.", tradeoff: "A volume to manage." },
    ],
    choice: null,
    rejected: [],
    supersedes: [],
    evidence: [],
    decided_by: null,
    decided_on: null,
    reviews: [],
    constrains: ["member:app"],
  };
}

type RecordView = { id: string; state: string; valid: boolean; data: Record<string, unknown>; quorum?: { agreed: number; met: boolean } };
function recordsOf(doc: unknown): RecordView[] {
  return (doc as { records: RecordView[] }).records;
}

describe("which servers have the workspace tools", () => {
  const names = [...workspaceReadTools, ...workspaceWriteTools].map((t) => t.name);

  test("a server at or inside a declared workspace lists them", async () => {
    for (const cwd of [ws.dir, join(ws.dir, "decisions")]) {
      const { tools } = (await rpc(server(cwd), "tools/list")) as { tools: { name: string }[] };
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(names));
    }
    expect(names).toEqual(["workspace-ls", "workspace-status", "workspace-graph", "workspace-records", "workspace-points", "records-new", "records-amend", "records-review", "records-close", "points-answer"]);
  });

  test("a server outside any workspace, or given none, does not", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "chant-mcp-no-ws-")));
    try {
      for (const s of [server(outside), new McpServer([])]) {
        const { tools } = (await rpc(s, "tools/list")) as { tools: { name: string }[] };
        expect(tools.map((t) => t.name).filter((n) => names.includes(n))).toEqual([]);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the descriptions say records are proposals and by names who proposed or decided", () => {
    for (const t of workspaceWriteTools) expect(t.description).toMatch(/proposals until they are reviewed.*by must name the person or agent that actually proposed or decided it/s);
  });
});

describe("reads", () => {
  test("workspace-records returns the document chant workspace records --json prints", async () => {
    const s = server();
    const res = await call(s, "workspace-records", { kind: KIND });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual(cli(["workspace", "records", "--kind", KIND, "--json"]));
    const only = await call(s, "workspace-records", { kind: KIND, id: "fix-001" });
    expect(recordsOf(only.structuredContent).map((r) => r.id)).toEqual(["fix-001"]);
  }, 120_000);

  test("workspace-points returns the document chant workspace points --json prints, and points-answer the write's (ws-058)", async () => {
    const s = server();
    const res = await call(s, "workspace-points", { open: true });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual(cli(["workspace", "points", "--open", "--json"]));
    expect(res.structuredContent).toMatchObject({ open: true, sources: [], points: [], questions: [] });
    // The generated workspace declares no answer kind, so there is nothing to answer.
    const answered = await call(s, "points-answer", { id: "slice-tier-000000000000", answer: "small", by: ["alice"] });
    expect(answered.structuredContent).toMatchObject({ verb: "answer", error: { code: "points-undeclared" } });
    const bad = await call(s, "points-answer", { id: "slice-tier-000000000000", answer: "small", by: [] });
    expect(bad.isError).toBe(true);
  }, 120_000);

  test("an error document is returned as a document, and a flag-shaped value is refused before chant runs", async () => {
    const s = server();
    const missing = await call(s, "workspace-records", { kind: "nowhere/none.kind.mjs" });
    expect(missing.structuredContent).toMatchObject({ error: { code: "kind-unreadable" } });
    const flag = await call(s, "workspace-ls", { at: "--output=/tmp/x" });
    expect(flag.isError).toBe(true);
    expect(flag.content[0].text).toMatch(/at may not start with -/);
  }, 120_000);

  test("the conformance suite's argv maps to the tool that answers it", () => {
    expect(mcpToolCall(["workspace", "records", "--kind", KIND, "--json"])).toEqual({ name: "workspace-records", arguments: { kind: KIND } });
    expect(mcpToolCall(["workspace", "status", "dev", "--json"])).toEqual({ name: "workspace-status", arguments: { env: "dev" } });
    expect(mcpToolCall(["workspace", "graph", "--intent", "a.mjs:1", "--kind", KIND, "--json"])).toEqual({ name: "workspace-graph", arguments: { intent: "a.mjs:1", kind: [KIND] } });
    expect(mcpToolCall(["workspace", "graph", "--composites", "--json"])).toEqual({ name: "workspace-graph", arguments: { composites: true } });
    expect(mcpToolCall(["workspace", "check", "--format", "json"])).toBeUndefined();
  });
});

describe("writes", () => {
  test("records-new proposes a decision with MCP in its source, records reads it, and reviews move its quorum", async () => {
    const s = server();
    await rpc(s, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } });
    const made = await call(s, "records-new", { kind: KIND, record: proposal("Where the logs go") });
    expect(made.structuredContent).toMatchObject({ id: "fix-002", dryRun: false });
    const read = recordsOf(cli(["workspace", "records", "--kind", KIND, "--json"])).find((r) => r.id === "fix-002")!;
    expect(read).toMatchObject({ state: "proposed", valid: true });
    expect(read.data.source).toEqual({ via: "mcp", client: { name: "claude-code", version: "2.1.0" } });

    for (const by of ["bob", "carol"]) {
      const res = await call(s, "records-review", { kind: KIND, id: "fix-002", verdict: "agree", by });
      expect(res.structuredContent).toMatchObject({ review: { reviewer: by, verdict: "agree" } });
    }
    const after = await call(s, "workspace-records", { kind: KIND, id: "fix-002" });
    expect(recordsOf(after.structuredContent)[0].quorum).toMatchObject({ agreed: 2, met: true });
  }, 180_000);

  test("a second client is recorded as itself, from the request's _meta", async () => {
    const s = server();
    await rpc(s, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } });
    const made = await call(s, "records-new", { kind: KIND, record: { ...proposal("Where the metrics go"), source: { kind: "workspace", member: "app" } } }, {
      "io.modelcontextprotocol/clientInfo": { name: "codex", version: "0.40.0" },
    });
    const id = (made.structuredContent as { id: string }).id;
    const read = recordsOf(cli(["workspace", "records", "--kind", KIND, "--json"])).find((r) => r.id === id)!;
    expect(read.data.source).toEqual({ kind: "workspace", member: "app", via: "mcp", client: { name: "codex", version: "0.40.0" } });
  }, 120_000);

  test("keeps the CLI's rules: a record opens proposed, a decided record's reasoning stays, by and sign", async () => {
    const s = server();
    const decided = await call(s, "records-new", {
      kind: KIND,
      record: { ...proposal("Decided at once"), state: "decided", choice: { option: "a", reason: "Simplest." }, decided_by: "lex00", decided_on: "2026-09-25" },
    });
    expect(decided.structuredContent).toMatchObject({ error: { code: "record-state-not-initial", message: expect.stringContaining("opens proposed") } });

    const reasoning = await call(s, "records-amend", { kind: KIND, id: "fix-001", fields: { question: "Something else?" } });
    expect(reasoning.structuredContent).toMatchObject({ error: { code: "amend-supersede-instead" } });

    // A new record opens proposed (MCP forces it), so by names the proposer, in proposedBy's field, not the decider (#2756).
    const both = await call(s, "records-new", { kind: KIND, record: { ...proposal("Two proposers"), proposed_by: "alice" }, by: "bob", dryRun: true });
    expect(both.structuredContent).toMatchObject({ error: { code: "write-input-invalid" } });
    const by = await call(s, "records-new", { kind: KIND, record: proposal("One proposer"), by: "alice", dryRun: true });
    expect(by.structuredContent, JSON.stringify(by.structuredContent)).toHaveProperty("text");
    expect((by.structuredContent as { text: string }).text).toContain('proposed_by: "alice"');
    expect((by.structuredContent as { text: string }).text).toContain("decided_by: null");

    // --sign seals the decider, and a record by names as proposed carries no decided_by yet.
    const signed = await call(s, "records-new", { kind: KIND, record: proposal("Signed"), by: "alice", sign: true, dryRun: true });
    expect(signed.structuredContent).toMatchObject({ error: { code: "record-sign-failed", message: expect.stringContaining("names no decided_by") } });

    // Nothing above wrote a file.
    expect(readFileSync(join(ws.dir, "decisions", "fix-001-how-the-app-is-deployed.md"), "utf-8")).toContain('question: "What declares the app\'s deployment?"');
  }, 180_000);
});
