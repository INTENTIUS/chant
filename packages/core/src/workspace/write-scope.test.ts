/**
 * Write scope per member and record kind, and agent sessions bound to one
 * member (#2548, ws-067), on a workspace built in a throwaway git repository.
 *
 * main holds a declaration with two members, app and design, the workspace's
 * own decision kind and a decision kind design declares, a trust policy that
 * grants ci@example.com the runner role, and:
 *
 * - writeScope.agent: decisions may be proposed (new) and reviewed, not amended;
 * - writeScope.runner: app's files only, and decision reviews only;
 * - agents app-agent (app, listing bot@example.com) and design-agent (design).
 *
 * The record writes, the MCP tools, `check --changes` and `workspace agent`
 * all read the scope from main, so a working-tree edit can't widen it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { agentSession } from "./agent-cli";
import agentSchema from "./agent.schema.json";
import { checkChanges, type ChangesDocument } from "./changes";
import changesSchema from "./changes.schema.json";
import { formatChanges } from "./changes-cli";
import { parseDeclaration, WorkspaceReadError } from "./declaration";
import { parseFrontMatter } from "./records";
import { amendRecord, newRecord, renderRecord, reviewRecord } from "./records-write";
import { emptyPolicy } from "./trust/policy";
import { judgePath, judgeRecord, principalClass, resolveWriter, WriteScopeError } from "./write-scope";
import { createWorkspaceTools } from "../cli/mcp/workspace-tools";

const DECISIONS = join(REPO, "docs", "design", "decisions");
const KIND = "decisions/decision.kind.mjs";
const DESIGN_KIND = "design/decisions/decision.kind.mjs";

type Data = Record<string, unknown>;

const SAMPLE = (() => {
  const fm = parseFrontMatter(readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

const decided = (over: Data): Data => ({ ...structuredClone(SAMPLE), ...over });
const proposal = (over: Data): Data => decided({ state: "proposed", choice: null, decided_by: null, decided_on: null, ...over });
const record = (d: Data) => renderRecord(d, `\n# ${String(d.title)}\n`);

const SCOPE = {
  agent: { records: { decision: ["new", "review"] } },
  runner: { members: ["app"], records: { decision: ["review"] } },
};
const AGENTS = [
  { name: "app-agent", member: "app", principals: ["bot@example.com"] },
  { name: "design-agent", member: "design" },
];

function declaration(scope: unknown = SCOPE, agents: unknown = AGENTS): string {
  return JSON.stringify(
    {
      name: "studio",
      schema: 1,
      members: [
        { name: "app", dir: "app", kind: "other", because: "a plain Node server" },
        { name: "design", dir: "design", kind: "other", because: "screens", records: [{ kind: "decisions/decision.kind.mjs", name: "screen" }] },
      ],
      records: [{ kind: KIND }],
      writeScope: scope,
      agents,
    },
    null,
    2,
  );
}

let root: string;
const sha: Record<string, string> = {};

function commit(message: string, email?: string): string {
  git(root, "add", "-A");
  git(root, ...(email ? ["-c", `user.email=${email}`] : []), "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

beforeAll(() => {
  const kind = readFileSync(join(DECISIONS, "decision.kind.mjs"), "utf-8");
  const schema = readFileSync(join(DECISIONS, "decision.schema.json"), "utf-8");
  root = repo({
    "chant.workspace.json": declaration(),
    ".chant/trust.json": JSON.stringify({ schema: 1, roles: { runner: ["ci@example.com"] } }),
    [KIND]: kind,
    "decisions/decision.schema.json": schema,
    "decisions/ws-001-one.md": record(decided({ id: "ws-001", title: "One" })),
    [DESIGN_KIND]: kind,
    "design/decisions/decision.schema.json": schema,
    "design/decisions/ws-001-screen.md": record(decided({ id: "ws-001", title: "Screen" })),
    "app/server.mjs": "export const port = 8080;\n",
    "design/spec.md": "# Spec\n",
  });
  sha.base = commit("the workspace");
  git(root, "branch", "-M", "main");
});
afterAll(cleanScratch);

const code = (doc: object) => ("error" in doc ? (doc as { error: { code: string } }).error.code : null);
const newDecision = (title: string) => JSON.stringify(proposal({ id: undefined, title }));

describe("the declaration's writeScope and agents (#2548)", () => {
  test("are read with their defaults", () => {
    const d = parseDeclaration(declaration(), "chant.workspace.json");
    expect(d.writeScope).toEqual({
      agent: { members: null, records: { decision: ["new", "review"] }, protected: [], pointer: "/writeScope/agent" },
      runner: { members: ["app"], records: { decision: ["review"] }, protected: [], pointer: "/writeScope/runner" },
    });
    expect(d.agents.map((a) => [a.name, a.member, a.principals])).toEqual([
      ["app-agent", "app", ["bot@example.com"]],
      ["design-agent", "design", []],
    ]);
    const none = parseDeclaration(JSON.stringify({ name: "w", schema: 1, members: [] }), "chant.workspace.json");
    expect([none.writeScope, none.agents]).toEqual([null, []]);
  });

  test.each([
    ["an agent bound to no declared member", declaration(SCOPE, [{ name: "a", member: "nowhere" }]), /not a declared member/],
    ["a scope naming no declared member", declaration({ human: { members: ["nowhere"] } }), /does not declare/],
    ["a principal two sessions list", declaration(SCOPE, [{ name: "a", member: "app", principals: ["p"] }, { name: "b", member: "design", principals: ["p"] }]), /already listed by agent a/],
    ["two sessions with one name", declaration(SCOPE, [{ name: "a", member: "app" }, { name: "a", member: "design" }]), /already used/],
    ["a members list on the agent class", declaration({ agent: { members: ["app"] } }), /members/],
    ["an unknown verb", declaration({ agent: { records: { decision: ["delete"] } } }), /must be equal to one of the allowed values|delete/],
  ])("refuse %s", (_, text, message) => {
    let err: unknown;
    try {
      parseDeclaration(text, "chant.workspace.json");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkspaceReadError);
    expect((err as WorkspaceReadError).code).toBe("declaration-invalid");
    expect((err as Error).message).toMatch(message);
  });
});

describe("judging a write", () => {
  const decl = parseDeclaration(declaration(), "chant.workspace.json");
  const policy = { ...emptyPolicy("x"), roles: { runner: ["CI@example.com"], agent: ["model@example.com"] } };
  const ws = { name: "decision", declaredName: null, member: null, declared: true };
  const screen = { name: "decision", declaredName: "screen", member: "design", declared: true };

  test("a principal's class comes from its role grants at base, and human is the rest", () => {
    expect(principalClass(policy, "ci@example.com")).toBe("runner");
    expect(principalClass(policy, "model@example.com")).toBe("agent");
    expect(principalClass(policy, "lex00")).toBe("human");
    expect(principalClass(policy, null)).toBe("human");
  });

  test("a session is named, or found by a principal it lists; an unknown one is refused", () => {
    expect(resolveWriter(decl, policy, { agent: "app-agent" }).agent?.member).toBe("app");
    expect(resolveWriter(decl, policy, { principal: "Bot@example.com" })).toMatchObject({ class: "agent", agent: { name: "app-agent" } });
    expect(resolveWriter(decl, policy, { principal: "lex00" })).toMatchObject({ class: "human", agent: null });
    expect(() => resolveWriter(decl, policy, { agent: "ghost" })).toThrow(WriteScopeError);
    expect(() => resolveWriter(null, policy, { agent: "ghost" })).toThrow(/no workspace declaration/);
  });

  test("an agent writes its own member, the workspace's kinds as its records rule allows, and nothing of another member", () => {
    const app = resolveWriter(decl, policy, { agent: "app-agent" });
    expect(judgePath(decl, app, "app/server.mjs")).toEqual({ ok: true });
    expect(judgePath(decl, app, "design/spec.md")).toMatchObject({ ok: false, code: "write-scope-member" });
    expect(judgePath(decl, app, "chant.workspace.json")).toMatchObject({ ok: false, code: "write-scope-member", message: expect.stringContaining("in no member") });
    expect(judgeRecord(decl, app, ws, "new")).toEqual({ ok: true });
    expect(judgeRecord(decl, app, ws, "review")).toEqual({ ok: true });
    expect(judgeRecord(decl, app, ws, "amend")).toMatchObject({ ok: false, code: "write-scope-kind", message: expect.stringContaining("may new, review decision records, and not amend") });
    expect(judgeRecord(decl, app, ws, "delete")).toMatchObject({ ok: false, code: "write-scope-kind" });
    expect(judgeRecord(decl, app, screen, "new")).toMatchObject({ ok: false, code: "write-scope-member" });
    const design = resolveWriter(decl, policy, { agent: "design-agent" });
    expect(judgeRecord(decl, design, screen, "new")).toEqual({ ok: true });
  });

  test("an agent by role with no session reaches only the workspace's own kinds", () => {
    const model = resolveWriter(decl, policy, { principal: "model@example.com" });
    expect(model).toMatchObject({ class: "agent", agent: null });
    expect(judgePath(decl, model, "app/server.mjs")).toMatchObject({ ok: false, message: expect.stringContaining("which no agent session lists") });
    expect(judgeRecord(decl, model, ws, "new")).toEqual({ ok: true });
  });

  test("a class with an entry is held to its members and kinds; a class with none is not restricted", () => {
    const ci = resolveWriter(decl, policy, { principal: "ci@example.com" });
    expect(judgePath(decl, ci, "app/server.mjs")).toEqual({ ok: true });
    expect(judgePath(decl, ci, "design/spec.md")).toMatchObject({ ok: false, code: "write-scope-member" });
    expect(judgeRecord(decl, ci, ws, "review")).toEqual({ ok: true });
    expect(judgeRecord(decl, ci, ws, "new")).toMatchObject({ ok: false, code: "write-scope-kind", message: expect.stringContaining("may review decision records, and not new") });
    expect(judgeRecord(decl, ci, screen, "review")).toMatchObject({ ok: false, code: "write-scope-member" });
    const human = resolveWriter(decl, policy, { principal: "lex00" });
    expect(judgePath(decl, human, "design/spec.md")).toEqual({ ok: true });
    expect(judgeRecord(decl, human, screen, "delete")).toEqual({ ok: true });
  });

  test("the declared name of a kind is a key for its records rule too", () => {
    const d = parseDeclaration(declaration({ agent: { records: { screen: ["new"] } } }), "chant.workspace.json");
    const design = resolveWriter(d, policy, { agent: "design-agent" });
    expect(judgeRecord(d, design, screen, "new")).toEqual({ ok: true });
    expect(judgeRecord(d, design, ws, "new")).toMatchObject({ ok: false, code: "write-scope-kind", message: expect.stringContaining("does not list the kind") });
  });
});

describe("the record writes refuse a write outside the writer's scope (CLI functions and MCP tools)", () => {
  test("an agent session proposes and reviews a decision, and may not amend one", async () => {
    const created = await newRecord({ kind: KIND, fields: newDecision("Logs"), cwd: root, agent: "app-agent", dryRun: true });
    expect(code(created)).toBeNull();
    const reviewed = await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: "app-agent", cwd: root, agent: "app-agent", dryRun: true });
    expect(code(reviewed)).toBeNull();
    const amended = await amendRecord({ kind: KIND, id: "ws-001", fields: JSON.stringify({ state: "ratified" }), cwd: root, agent: "app-agent", dryRun: true });
    expect(amended).toMatchObject({ error: { code: "write-scope-kind", message: expect.stringContaining("agent session app-agent, bound to member app,") } });
  });

  test("an agent session may not write another member's records", async () => {
    expect(code(await newRecord({ kind: DESIGN_KIND, fields: newDecision("Screen two"), cwd: root, agent: "app-agent", dryRun: true }))).toBe("write-scope-member");
    expect(code(await newRecord({ kind: DESIGN_KIND, fields: newDecision("Screen two"), cwd: root, agent: "design-agent", dryRun: true }))).toBeNull();
  });

  test("an unknown session is refused; a write naming no session is a human's, and a listed principal is its session's", async () => {
    expect(code(await newRecord({ kind: KIND, fields: newDecision("Logs"), cwd: root, agent: "ghost", dryRun: true }))).toBe("agent-unknown");
    expect(code(await amendRecord({ kind: KIND, id: "ws-001", fields: JSON.stringify({ title: "One, retitled" }), cwd: root, dryRun: true }))).toBe("amend-supersede-instead");
    expect(code(await amendRecord({ kind: KIND, id: "ws-001", fields: JSON.stringify({ state: "ratified" }), by: "bot@example.com", cwd: root, dryRun: true }))).toBe("write-scope-kind");
  });

  test("a runner, by its role at base, reviews and does not propose", async () => {
    expect(code(await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: "ci@example.com", cwd: root, dryRun: true }))).toBeNull();
    expect(code(await newRecord({ kind: KIND, fields: newDecision("Logs"), by: "ci@example.com", cwd: root, dryRun: true }))).toBe("write-scope-kind");
  });

  test("the scope is read at base: widening it in the working tree changes nothing until it is merged", async () => {
    writeFiles(root, { "chant.workspace.json": declaration({ agent: { records: { decision: ["new", "review", "amend"] } } }) });
    try {
      expect(code(await amendRecord({ kind: KIND, id: "ws-001", fields: JSON.stringify({ state: "ratified" }), cwd: root, agent: "app-agent", dryRun: true }))).toBe("write-scope-kind");
    } finally {
      writeFiles(root, { "chant.workspace.json": declaration() });
    }
  });

  test("the MCP record tools write in the server's session, with the CLI's codes", async () => {
    const tools = createWorkspaceTools({ cwd: root, agent: "app-agent", chantCommand: ["false"] });
    const tool = (name: string) => tools.find((t) => t.definition.name === name)!.handler;
    const amended = (await tool("records-amend")({ id: "ws-001", kind: KIND, fields: { state: "ratified" }, dryRun: true })) as object;
    expect(code(amended)).toBe("write-scope-kind");
    const other = (await tool("records-new")({ kind: DESIGN_KIND, record: proposal({ id: undefined, title: "Screen two", state: undefined }), dryRun: true })) as object;
    expect(code(other)).toBe("write-scope-member");
    const own = (await tool("records-new")({ kind: KIND, record: proposal({ id: undefined, title: "Logs", state: undefined }), dryRun: true })) as object;
    expect(code(own)).toBeNull();
  });
});

describe("check --changes fails a commit outside its writer's scope (#2548)", () => {
  const changes = contract(changesSchema);
  let doc: Exclude<ChangesDocument, { error: unknown }>;
  let failed: boolean;

  beforeAll(async () => {
    git(root, "checkout", "-q", "-b", "work");
    const trailer = (name: string) => `\n\nChant-Agent: ${name}`;
    writeFiles(root, { "app/server.mjs": "export const port = 9090;\n" });
    sha.inMember = commit(`app: a port${trailer("app-agent")}`);
    writeFiles(root, { "design/spec.md": "# Spec, by the app agent\n" });
    sha.otherMember = commit(`design: an edit${trailer("app-agent")}`);
    writeFiles(root, { "decisions/ws-002-logs.md": record(proposal({ id: "ws-002", title: "Logs" })) });
    sha.proposed = commit(`a proposal${trailer("app-agent")}`);
    writeFiles(root, { "decisions/ws-001-one.md": record(decided({ id: "ws-001", title: "One", reviews: [{ reviewer: "app-agent", verdict: "agree", on: "2026-09-30" }] })) });
    sha.reviewed = commit(`a review${trailer("app-agent")}`);
    writeFiles(root, { "decisions/ws-001-one.md": record(decided({ id: "ws-001", title: "One, decided again", reviews: [{ reviewer: "app-agent", verdict: "agree", on: "2026-09-30" }] })) });
    sha.amended = commit(`an amendment${trailer("app-agent")}`);
    writeFiles(root, { "chant.workspace.json": declaration({ agent: { records: { decision: ["new", "review", "amend"] } } }) });
    sha.widened = commit(`widen my scope${trailer("app-agent")}`);
    writeFiles(root, { "app/server.mjs": "export const port = 9191;\n" });
    sha.ghost = commit(`a ghost${trailer("ghost")}`);
    writeFiles(root, { "design/spec.md": "# Spec, by CI\n" });
    sha.runner = commit("ci: an edit", "ci@example.com");
    writeFiles(root, { "design/spec.md": "# Spec, by a person\n", "chant.workspace.json": declaration() });
    sha.human = commit("a person's edit");
    ({ doc, failed } = (await checkChanges({ cwd: root, range: "main..work" })) as { doc: Exclude<ChangesDocument, { error: unknown }>; failed: boolean });
  });

  test("the document validates and the check fails", () => {
    changes.expectValid(doc);
    expect(failed).toBe(true);
    expect(doc.ok).toBe(false);
    expect(doc.scope).toMatchObject({ base: sha.base, restricted: ["agent", "runner"], agents: ["app-agent", "design-agent"] });
  });

  test("each commit is judged as its session, its role, or a person", () => {
    const by = Object.fromEntries(doc.scope!.commits.map((c) => [c.commit, [c.class, c.agent, c.principal, c.attested]]));
    expect(by[sha.inMember]).toEqual(["agent", "app-agent", "t@example.com", false]);
    expect(by[sha.ghost]).toEqual(["agent", "ghost", "t@example.com", false]);
    expect(by[sha.runner]).toEqual(["runner", null, "ci@example.com", false]);
    expect(by[sha.human]).toEqual(["human", null, "t@example.com", false]);
  });

  test("a finding for each write outside scope, and none for one inside it", () => {
    const found = doc.scope!.findings.map((f) => [Object.entries(sha).find(([, s]) => s === f.commit)![0], f.code, f.path, f.verb]);
    expect(found).toEqual([
      ["otherMember", "write-scope-member", "design/spec.md", null],
      ["amended", "write-scope-kind", "decisions/ws-001-one.md", "amend"],
      ["widened", "write-scope-member", "chant.workspace.json", null],
      ["ghost", "agent-unknown", null, null],
      ["runner", "write-scope-member", "design/spec.md", null],
    ]);
    expect(formatChanges(doc)).toContain(`error     write-scope-kind: ${sha.amended.slice(0, 8)} changes decisions/ws-001-one.md: agent session app-agent`);
  });

  test("an empty range judges no commit", async () => {
    const { doc: before } = await checkChanges({ cwd: root, range: `${sha.base}~0..${sha.base}` });
    expect("error" in before ? before : before.scope).toMatchObject({ base: sha.base, commits: [], findings: [] });
  });
});

describe("chant workspace agent: what a session reloads from (#2548)", () => {
  const agent = contract(agentSchema);

  test("the session, its member, its scope and the spec, read from the repository", async () => {
    const doc = await agentSession({ cwd: root, name: "design-agent" });
    agent.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.workspace).toEqual({ name: "studio", root: ".", scopeFrom: "base" });
    expect(doc.agent).toEqual({ name: "design-agent", member: { name: "design", dir: "design", kind: "other" }, principals: [] });
    expect(doc.scope).toEqual({
      members: ["design"],
      records: [
        { path: KIND, kind: "decision", name: null, member: null, verbs: ["new", "review"] },
        { path: DESIGN_KIND, kind: "decision", name: "screen", member: "design", verbs: ["new", "review"] },
      ],
      protected: [],
    });
    expect(doc.spec.kinds.map((k) => k.path)).toEqual([KIND, DESIGN_KIND]);
    expect(doc.spec.records.map((r) => `${r.kind}/${r.id}`)).toContain("decision/ws-001");
    expect(doc.reload).toEqual(["chant workspace agent design-agent --json", "chant workspace records --current --json"]);
  });

  test("an unknown session is an error document", async () => {
    const doc = await agentSession({ cwd: root, name: "ghost" });
    agent.expectValid(doc);
    expect(code(doc)).toBe("agent-unknown");
  });
});
