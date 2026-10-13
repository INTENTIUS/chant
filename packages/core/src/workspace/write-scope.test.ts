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
import { runDeclarationChecks } from "./checks";
import changesSchema from "./changes.schema.json";
import { formatChanges } from "./changes-cli";
import { parseDeclaration, WorkspaceReadError } from "./declaration";
import { parseFrontMatter } from "./records";
import { amendRecord, newRecord, renderRecord, reviewRecord } from "./records-write";
import { emptyPolicy } from "./trust/policy";
import { judgePath, judgeRecord, onlyKeysChanged, principalClass, resolveWriter, WriteScopeError } from "./write-scope";
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
    ["an agent naming an undeclared member among several", declaration(SCOPE, [{ name: "a", members: ["app", "nowhere"] }]), /"nowhere", which is not a declared member/],
    ["an agent with both member and members", declaration(SCOPE, [{ name: "a", member: "app", members: ["design"] }]), /oneOf|exactly one|must match/],
    ["an agent with an empty members list", declaration(SCOPE, [{ name: "a", members: [] }]), /fewer than 1|minItems|members/],
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

describe("a protected JSON file's except by JSON Pointer (#3308)", () => {
  const decl = (listing: unknown, intent = "ws-001") => JSON.stringify({ name: "w", members: [{ name: "a", box: { intent, listing } }, { name: "b" }] });
  test("a * token matches every key or index at its level, and only what the pointer names may change", () => {
    expect(onlyKeysChanged(decl({ title: "A" }), decl({ title: "B" }), ["/members/*/box/listing"])).toBe(true);
    expect(onlyKeysChanged(decl({ title: "A" }), decl(undefined), ["/members/*/box/listing"])).toBe(true);
    expect(onlyKeysChanged(decl({ title: "A" }), decl({ title: "B" }, "ws-002"), ["/members/*/box/listing"])).toBe(false);
    expect(onlyKeysChanged(decl({ title: "A" }), decl({ title: "B" }), ["/members/1/box/listing"])).toBe(false);
    expect(onlyKeysChanged(decl({ title: "A" }), decl({ title: "B" }), ["/members/0/box/listing"])).toBe(true);
    expect(onlyKeysChanged(decl({ title: "A" }), decl({ title: "B" }), ["name"])).toBe(false);
  });
  test("reads a .jsonc file's comments and trailing commas", () => {
    expect(onlyKeysChanged('{ "a": 1, // x\n "b": 2, }', '{ "a": 1, "b": 3 }', ["b"])).toBe(true);
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

  test("an agent bound to several members writes in any of them, and its scope is their union (ws-101)", () => {
    const d = parseDeclaration(declaration(SCOPE, [...AGENTS, { name: "factory", members: ["app", "design"] }]), "chant.workspace.json");
    expect(d.agents.find((a) => a.name === "factory")).toMatchObject({ members: ["app", "design"], member: "app" });
    expect(d.agents.find((a) => a.name === "app-agent")).toMatchObject({ members: ["app"], member: "app" });
    const factory = resolveWriter(d, policy, { agent: "factory" });
    expect(judgePath(d, factory, "app/server.mjs")).toEqual({ ok: true });
    expect(judgePath(d, factory, "design/spec.md")).toEqual({ ok: true });
    expect(judgePath(d, factory, "chant.workspace.json")).toMatchObject({ ok: false, code: "write-scope-member", message: expect.stringContaining("agent session factory, bound to members app, design,") });
    expect(judgeRecord(d, factory, screen, "new")).toEqual({ ok: true });
    expect(judgeRecord(d, factory, ws, "new")).toEqual({ ok: true });
    expect(judgeRecord(d, factory, screen, "amend")).toMatchObject({ ok: false, code: "write-scope-kind" });
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
    const design = { name: "design", dir: "design", kind: "other" };
    expect(doc.agent).toEqual({ name: "design-agent", member: design, members: [design], principals: [] });
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

describe("principal classes a plugin defines (#3080)", () => {
  const PLUGIN = "plugins/review";
  const PRINCIPALS = JSON.stringify({ schema: 1, classes: [{ name: "reviewer", description: "people who review decisions", role: "reviewer" }] });
  const REVIEWER_SCOPE = { reviewer: { members: ["design"], records: { decision: ["review"] } } };
  let dom: string;
  const at: Record<string, string> = {};

  function domainDeclaration(scope: unknown): string {
    return JSON.stringify({ ...JSON.parse(declaration(scope, [])), pins: [{ path: PLUGIN }] }, null, 2);
  }
  function commitIn(message: string, email?: string): string {
    git(dom, "add", "-A");
    git(dom, ...(email ? ["-c", `user.email=${email}`] : []), "commit", "-q", "-m", message);
    return git(dom, "rev-parse", "HEAD");
  }

  beforeAll(() => {
    const kind = readFileSync(join(DECISIONS, "decision.kind.mjs"), "utf-8");
    const schema = readFileSync(join(DECISIONS, "decision.schema.json"), "utf-8");
    dom = repo({
      "chant.workspace.json": domainDeclaration(REVIEWER_SCOPE),
      ".chant/trust.json": JSON.stringify({ schema: 1, roles: { reviewer: ["rev@example.com"] } }),
      [`${PLUGIN}/package.json`]: JSON.stringify({ name: "review-classes", version: "1.0.0", exports: { "./workspace-principals": "./workspace-principals.json" } }),
      [`${PLUGIN}/workspace-principals.json`]: PRINCIPALS,
      [KIND]: kind,
      "decisions/decision.schema.json": schema,
      "decisions/ws-001-one.md": record(decided({ id: "ws-001", title: "One" })),
      [DESIGN_KIND]: kind,
      "design/decisions/decision.schema.json": schema,
      "design/decisions/ws-001-screen.md": record(decided({ id: "ws-001", title: "Screen" })),
      "app/server.mjs": "export const port = 8080;\n",
      "design/spec.md": "# Spec\n",
    });
    at.base = commitIn("the workspace");
    git(dom, "branch", "-M", "main");
  });

  test("writeScope takes a domain class's name as a key, in file order", () => {
    const d = parseDeclaration(domainDeclaration({ reviewer: { records: { decision: ["review"] } }, human: {} }), "chant.workspace.json");
    expect(Object.keys(d.writeScope!)).toEqual(["reviewer", "human"]);
    expect(() => parseDeclaration(domainDeclaration({ "x-reviewer": {} }), "chant.workspace.json")).toThrow(WorkspaceReadError);
    expect(() => parseDeclaration(domainDeclaration({ Reviewer: {} }), "chant.workspace.json")).toThrow(WorkspaceReadError);
  });

  test("a principal holding the class's role at base is held to its entry; anyone else is a human", async () => {
    expect(code(await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: "rev@example.com", cwd: dom, dryRun: true }))).toBeNull();
    const proposed = await newRecord({ kind: KIND, fields: newDecision("Logs"), by: "rev@example.com", cwd: dom, dryRun: true });
    expect(proposed).toMatchObject({ error: { code: "write-scope-kind", message: expect.stringContaining("rev@example.com (reviewer) may review decision records, and not new") } });
    expect(code(await newRecord({ kind: KIND, fields: newDecision("Logs"), by: "lex00", cwd: dom, dryRun: true }))).toBeNull();
  });

  test("a path-pinned plugin's classes are read at base: remapping the class in the working tree changes nothing", async () => {
    writeFiles(dom, { [`${PLUGIN}/workspace-principals.json`]: JSON.stringify({ schema: 1, classes: [{ name: "reviewer", description: "d", role: "nobody" }] }) });
    try {
      expect(code(await newRecord({ kind: KIND, fields: newDecision("Logs"), by: "rev@example.com", cwd: dom, dryRun: true }))).toBe("write-scope-kind");
    } finally {
      writeFiles(dom, { [`${PLUGIN}/workspace-principals.json`]: PRINCIPALS });
    }
  });

  test("check --changes judges a commit by its author's domain class", async () => {
    git(dom, "checkout", "-q", "-b", "work");
    writeFiles(dom, { "app/server.mjs": "export const port = 9090;\n" });
    at.outside = commitIn("app: a port", "rev@example.com");
    writeFiles(dom, { "design/spec.md": "# Spec, reviewed\n" });
    at.inside = commitIn("design: a note", "rev@example.com");
    const { doc } = (await checkChanges({ cwd: dom, range: "main..work" })) as { doc: Exclude<ChangesDocument, { error: unknown }> };
    contract(changesSchema).expectValid(doc);
    expect(doc.scope).toMatchObject({ restricted: ["reviewer"] });
    expect(doc.scope!.commits.map((c) => [c.commit, c.class])).toEqual([
      [at.outside, "reviewer"],
      [at.inside, "reviewer"],
    ]);
    expect(doc.scope!.findings.map((f) => [f.commit, f.code, f.path, f.class])).toEqual([[at.outside, "write-scope-member", "app/server.mjs", "reviewer"]]);
    git(dom, "checkout", "-q", "main");
  });

  describe("a class no pinned package supplies fails closed", () => {
    beforeAll(() => {
      writeFiles(dom, { "chant.workspace.json": domainDeclaration({ ...REVIEWER_SCOPE, auditor: { members: ["design"] } }) });
      at.unknown = commitIn("an auditor class no plugin supplies");
    });

    test("a writer judged human is refused; one in a known class is judged by it", async () => {
      const refused = await newRecord({ kind: KIND, fields: newDecision("Logs"), by: "lex00", cwd: dom, dryRun: true });
      expect(refused).toMatchObject({ error: { code: "write-scope-class-unknown", message: expect.stringContaining("writeScope.auditor") } });
      expect(code(await newRecord({ kind: KIND, fields: newDecision("Logs"), cwd: dom, dryRun: true }))).toBe("write-scope-class-unknown");
      expect(code(await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: "rev@example.com", cwd: dom, dryRun: true }))).toBeNull();
    });

    test("check --changes reports the human's commit as a whole", async () => {
      git(dom, "checkout", "-q", "-b", "audit");
      writeFiles(dom, { "design/spec.md": "# Spec, by a person\n" });
      const human = commitIn("a person's edit");
      const { doc } = (await checkChanges({ cwd: dom, range: "main..audit" })) as { doc: Exclude<ChangesDocument, { error: unknown }> };
      contract(changesSchema).expectValid(doc);
      expect(doc.scope).toMatchObject({ restricted: ["reviewer", "auditor"] });
      expect(doc.scope!.findings.map((f) => [f.id, f.path, f.class])).toEqual([[`finding:write-scope-class-unknown:${human}`, null, "human"]]);
      git(dom, "checkout", "-q", "main");
    });

    test("workspace check reports the unknown class with WSP003", async () => {
      const report = await runDeclarationChecks(dom, undefined, { gather: false });
      const found = report.diagnostics.filter((d) => d.ruleId === "WSP003");
      expect(found).toHaveLength(1);
      expect(found[0].message).toMatch(/writeScope names the principal class auditor, which no core class or pinned package supplies/);
      expect(found[0].message).toMatch(/known classes: human, agent, runner, service, reviewer/);
    });
  });

  test("workspace check reports an unreadable principals file with WSP002", async () => {
    const root = repo({
      "chant.workspace.json": domainDeclaration(REVIEWER_SCOPE),
      [`${PLUGIN}/package.json`]: JSON.stringify({ exports: { "./workspace-principals": "./workspace-principals.json" } }),
      [`${PLUGIN}/workspace-principals.json`]: JSON.stringify({ schema: 1, classes: [{ name: "human", description: "d", role: "people" }] }),
      "app/server.mjs": "",
      "design/spec.md": "",
    });
    const report = await runDeclarationChecks(root, undefined, { gather: false });
    expect(report.diagnostics.filter((d) => d.ruleId === "WSP002").map((d) => d.message)).toEqual([`${PLUGIN}: class human is a core class and can't be supplied by a package`]);
    expect(report.diagnostics.filter((d) => d.ruleId === "WSP003").map((d) => d.message)).toEqual([expect.stringContaining("principal class reviewer")]);
  });
});
