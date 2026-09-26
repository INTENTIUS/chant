/**
 * chant #2680: the declaration names its record kinds. The declaration reads
 * them, `ls --json` lists them, `check` fails on one that doesn't load
 * (WSP115), and `records` and `graph --intent` read every one of them when
 * `--kind` is not given, while `--kind` still overrides.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../cli/main";
import { cleanScratch, commitAll, contract, git, repo, writeFiles } from "./__fixtures__/contract-repo";
import { runDeclarationChecks } from "./checks";
import { declaredRecordKinds, parseDeclaration, WorkspaceReadError } from "./declaration";
import { intentGraph } from "./intent";
import intentSchema from "./intent.schema.json";
import { listWorkspace, listWorkspaceWithKinds, type LsDocument } from "./ls";
import lsSchema from "./ls.schema.json";
import { declaredKindFiles, queryDeclaredRecords, runWorkspaceRecords } from "./records-cli";
import recordsSchema from "./records.schema.json";
import recordsSinceSchema from "./records-since.schema.json";
import { runRecordsWrite } from "./records-write";

afterAll(cleanScratch);

const REF = join(import.meta.dirname, "..", "..", "..", "..", "reference-workspace", "decisions");
const DECISION_KIND = readFileSync(join(REF, "decision.kind.mjs"), "utf-8");
const DECISION_SCHEMA = readFileSync(join(REF, "decision.schema.json"), "utf-8");
const REF_001 = readFileSync(join(REF, "ref-001-how-the-app-is-deployed.md"), "utf-8");

/** The decision kind under another name, reading only `note-*.md`, so two kinds never read the same file. */
const NOTE_KIND = DECISION_KIND.replace('name: "decision"', 'name: "note"').replace(/match: "[^"]*"/, 'match: "^note-[0-9]+\\\\.md$"');

const members = (extra: Record<string, unknown> = {}) => [
  { name: "app", dir: "app", kind: "other", because: "a plain Node server" },
  { name: "design", dir: "design", kind: "other", because: "the design data member", ...extra },
];

const decl = (m: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ name: "studio", schema: 1, members: m, ...extra }, null, 2);

const BASE_FILES = {
  "app/server.mjs": "export const port = 8080;\n",
  "decisions/decision.kind.mjs": DECISION_KIND,
  "decisions/decision.schema.json": DECISION_SCHEMA,
  "decisions/ref-001-how-the-app-is-deployed.md": REF_001,
  "design/notes/note.kind.mjs": NOTE_KIND,
  "design/notes/decision.schema.json": DECISION_SCHEMA,
  "design/notes/note-1.md": REF_001,
};

/** A workspace whose own records hold the decision kind, and whose design member holds the note kind. */
function workspace(extraFiles: Record<string, string> = {}, designRecords: unknown[] = [{ kind: "notes/note.kind.mjs", name: "notes" }]): string {
  return repo(
    {
      "chant.workspace.json": decl(members({ records: designRecords }), { records: [{ kind: "decisions/decision.kind.mjs" }] }),
      ...BASE_FILES,
      ...extraFiles,
    },
    true,
  );
}

describe("the declaration's records (#2680)", () => {
  test("the workspace's own and each member's, with paths from the workspace root, in reading order", () => {
    const d = parseDeclaration(
      decl(members({ records: [{ kind: "notes/note.kind.mjs", name: "notes" }] }), { records: [{ kind: "decisions/decision.kind.mjs" }] }),
      "chant.workspace.json",
    );
    expect(d.records).toEqual([{ kind: "decisions/decision.kind.mjs", path: "decisions/decision.kind.mjs", name: null, member: null, pointer: "/records/0" }]);
    expect(d.members.find((m) => m.name === "design")!.records).toEqual([
      { kind: "notes/note.kind.mjs", path: "design/notes/note.kind.mjs", name: "notes", member: "design", pointer: "/members/1/records/0" },
    ]);
    expect(d.members.find((m) => m.name === "app")!.records).toEqual([]);
    expect(declaredRecordKinds(d).map((k) => k.path)).toEqual(["decisions/decision.kind.mjs", "design/notes/note.kind.mjs"]);
  });

  test("a path outside the member, a path declared twice, a name given twice and an unknown field are declaration-invalid", () => {
    const refused = (text: string) => {
      try {
        parseDeclaration(text, "chant.workspace.json");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceReadError);
        return `${(err as WorkspaceReadError).code}: ${(err as WorkspaceReadError).message}`;
      }
      throw new Error("read");
    };
    expect(refused(decl(members({ records: [{ kind: "../decisions/decision.kind.mjs" }] })))).toMatch(/^declaration-invalid: .* is not a path inside the member/);
    expect(refused(decl([{ name: "root", dir: ".", kind: "other", because: "x", records: [{ kind: "decisions/d.kind.mjs" }] }], { records: [{ kind: "decisions/d.kind.mjs" }] }))).toBe(
      "declaration-invalid: the record kind decisions/d.kind.mjs is already declared at /records/0",
    );
    expect(refused(decl(members({ records: [{ kind: "a.kind.mjs", name: "x" }] }), { records: [{ kind: "b.kind.mjs", name: "x" }] }))).toBe(
      'declaration-invalid: the record kind name "x" is already given at /records/0',
    );
    expect(refused(decl(members(), { records: [{ kind: "a.kind.mjs", file: "b" }] }))).toMatch(/^declaration-invalid: unknown field "file"/);
  });
});

describe("workspace ls lists the declared kinds (#2680)", () => {
  const { expectValid } = contract(lsSchema);
  const result = (doc: LsDocument) => {
    expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    return doc;
  };

  test("with each kind file's name when it loads, and the reason when it doesn't", async () => {
    const root = workspace({ "design/broken.kind.mjs": "export const nothing = 1;\n" }, [
      { kind: "notes/note.kind.mjs", name: "notes" },
      { kind: "gone.kind.mjs" },
      { kind: "broken.kind.mjs" },
    ]);
    const doc = result(await listWorkspaceWithKinds({ cwd: root }));
    expect(doc.contract).toBe(1);
    expect(doc.workspace.records).toEqual([{ name: "decision", path: "decisions/decision.kind.mjs", kind: "decision", reason: null, acceptance: null }]);
    const design = doc.members.find((m) => m.name === "design")!;
    expect(design.readable).toBe(true);
    expect(design.records).toEqual([
      { name: "notes", path: "design/notes/note.kind.mjs", kind: "note", reason: null, acceptance: null },
      { name: null, path: "design/gone.kind.mjs", kind: null, reason: { code: "kind-unreadable", message: "kind file design/gone.kind.mjs does not exist" }, acceptance: null },
      { name: null, path: "design/broken.kind.mjs", kind: null, reason: { code: "kind-invalid", message: "kind file design/broken.kind.mjs is not a record kind: it has no recordKind export" }, acceptance: null },
    ]);
    expect(doc.members.find((m) => m.name === "app")!.records).toEqual([]);
  });

  test("listWorkspace lists them unloaded, and a workspace that names none lists empty arrays", async () => {
    const doc = result(listWorkspace({ cwd: workspace() }));
    expect(doc.workspace.records).toEqual([{ name: null, path: "decisions/decision.kind.mjs", kind: null, reason: null, acceptance: null }]);
    const none = result(await listWorkspaceWithKinds({ cwd: repo({ "chant.workspace.json": decl(members()), "app/x": "", "design/x": "" }) }));
    expect(none.workspace.records).toEqual([]);
    expect(none.members.map((m) => m.records)).toEqual([[], []]);
  });

  test("--at looks for the kind file in the revision", async () => {
    const root = workspace();
    const at = git(root, "rev-parse", "HEAD");
    git(root, "rm", "-q", "design/notes/note.kind.mjs");
    commitAll(root, "drop the note kind");
    const now = result(await listWorkspaceWithKinds({ cwd: root }));
    expect(now.members.find((m) => m.name === "design")!.records[0].reason?.code).toBe("kind-unreadable");
    // The revision still has the file; it loads from the working tree, where it is gone.
    const then = result(await listWorkspaceWithKinds({ cwd: root, at }));
    expect(then.members.find((m) => m.name === "design")!.records[0].reason?.code).toBe("kind-unreadable");
    expect(then.members.find((m) => m.name === "design")!.records[0].reason?.message).toContain("could not be loaded");
  });
});

describe("WSP115: a declared kind that doesn't load (#2680)", () => {
  test("fails check with the reason, pointing at the entry", async () => {
    const root = workspace({ "design/broken.kind.mjs": "export const nothing = 1;\n" }, [{ kind: "gone.kind.mjs" }, { kind: "broken.kind.mjs" }]);
    const report = await runDeclarationChecks(root);
    const wsp115 = report.diagnostics.filter((d) => d.ruleId === "WSP115");
    expect(wsp115.map((d) => [d.entity, d.message])).toEqual([
      ["design", "member design declares the record kind gone.kind.mjs, which can't be loaded: kind-unreadable: kind file design/gone.kind.mjs does not exist"],
      ["design", "member design declares the record kind broken.kind.mjs, which can't be loaded: kind-invalid: kind file design/broken.kind.mjs is not a record kind: it has no recordKind export"],
    ]);
    expect(wsp115.every((d) => d.severity === "error" && d.line > 1)).toBe(true);
    expect(report.ok).toBe(false);
  });

  test("finds nothing when every declared kind loads, and the check can't be suppressed", async () => {
    expect((await runDeclarationChecks(workspace())).diagnostics.filter((d) => d.ruleId === "WSP115")).toEqual([]);
    const root = workspace({}, [{ kind: "gone.kind.mjs" }]);
    writeFiles(root, {
      "chant.workspace.json": decl(members({ records: [{ kind: "gone.kind.mjs" }], suppress: [{ check: "WSP115", because: "later" }] })),
    });
    const ids = (await runDeclarationChecks(root)).diagnostics.map((d) => d.ruleId);
    expect(ids).toContain("WSP115");
    expect(ids).toContain("WSP011");
  });
});

describe("records without --kind reads every declared kind (#2680)", () => {
  const { expectValid } = contract(recordsSchema);
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());
  const run = (cwd: string, ...argv: string[]) => {
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    return runWorkspaceRecords({ args: parseArgs(["workspace", "records", ...argv]), plugins: [] } as never);
  };

  test("one document per kind in the declaration's order, as a set that validates", async () => {
    const root = workspace();
    const set = await queryDeclaredRecords(declaredKindFiles(root), { cwd: root, current: true });
    expectValid(set);
    expect(set.kinds.map((k) => ["error" in k ? k.error.code : k.kind.name, k.declared])).toEqual([
      ["decision", { member: null, path: "decisions/decision.kind.mjs", name: null }],
      ["note", { member: "design", path: "design/notes/note.kind.mjs", name: "notes" }],
    ]);
    expect(await run(root, "--json")).toBe(0);
    const printed = JSON.parse(out.join("\n"));
    expectValid(printed);
    expect(printed.kinds.map((k: { records: { id: string }[] }) => k.records.map((r) => r.id))).toEqual([["ref-001"], ["ref-001"]]);
  });

  test("a kind that can't be read is listed with its error, the others are read, and the exit code is 1", async () => {
    const root = workspace({}, [{ kind: "gone.kind.mjs" }]);
    expect(await run(root, "--json")).toBe(1);
    const printed = JSON.parse(out.join("\n"));
    expectValid(printed);
    expect(printed.kinds.map((k: { error?: { code: string }; records?: unknown[] }) => k.error?.code ?? k.records!.length)).toEqual([1, "kind-unreadable"]);
  });

  test("--kind overrides, and with neither --kind nor declared kinds the message is today's", async () => {
    const root = workspace();
    expect(await run(root, "--kind", "design/notes/note.kind.mjs", "--json")).toBe(0);
    const one = JSON.parse(out.join("\n"));
    expect(one.kind.name).toBe("note");
    expect(one.kinds).toBeUndefined();

    const bare = repo({ "chant.workspace.json": decl(members()), "app/x": "", "design/x": "" });
    expect(await run(bare)).toBe(1);
    expect(err.join("\n")).toContain("--kind <kind file> is required");
    err.length = 0;
    expect(await run(repo({ "x.md": "" }))).toBe(1);
    expect(err.join("\n")).toContain("--kind <kind file> is required");
  });

  test("--since compares every declared kind too, one records-since document per kind (#2673)", async () => {
    const root = workspace();
    writeFiles(root, { "decisions/ref-009-another.md": REF_001.replace('id: "ref-001"', 'id: "ref-009"') });
    expect(await run(root, "--since", "HEAD", "--json")).toBe(0);
    const printed = JSON.parse(out.join("\n"));
    contract(recordsSinceSchema).expectValid(printed);
    expect(printed.kinds.map((k: { kind: { name: string }; declared: { path: string }; changes: { change: string; id: string }[] }) => [k.declared.path, k.kind.name, k.changes.map((c) => `${c.change} ${c.id}`)])).toEqual([
      ["decisions/decision.kind.mjs", "decision", ["new ref-009"]],
      ["design/notes/note.kind.mjs", "note", []],
    ]);
    out.length = 0;
    expect(await run(root, "--since", "HEAD", "--kind", "design/notes/note.kind.mjs", "--json")).toBe(0);
    expect(JSON.parse(out.join("\n")).kind.name).toBe("note");
    expect(await run(root, "--since", "HEAD", "--current")).toBe(1);
  });

  test("text output heads each kind with its name and file", async () => {
    expect(await run(workspace(), "--current")).toBe(0);
    expect(out.filter((l) => l.includes("("))).toEqual(["decision (decisions/decision.kind.mjs)", "notes (design/notes/note.kind.mjs)"]);
  });

  test("--at an unknown revision with --json prints the error document, not just text on stderr (#2860)", async () => {
    const root = workspace();
    expect(await run(root, "--at", "refs/heads/no-such-branch", "--json")).toBe(1);
    expect(err).toEqual([]);
    const printed = JSON.parse(out.join("\n"));
    expectValid(printed);
    expect(printed).toEqual({
      $schema: recordsSchema.$id,
      contract: 1,
      error: { code: "revision-unknown", message: expect.stringContaining("refs/heads/no-such-branch") as unknown as string },
    });

    out.length = 0;
    err.length = 0;
    expect(await run(root, "--at", "refs/heads/no-such-branch")).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("revision-unknown");
  });

  test("a declaration-level code the records schema doesn't carry, such as declaration-invalid, stays text-only even with --json (#2860)", async () => {
    const root = repo({ "chant.workspace.json": decl(members(), { records: [{ kind: "a.kind.mjs", file: "b" }] }), "app/x": "", "design/x": "" });
    expect(await run(root, "--json")).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("declaration-invalid");
  });
});

describe("records new, amend and review without --kind (#2680)", () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());
  const run = async (cwd: string, ...argv: string[]) => {
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const status = await runRecordsWrite({ args: parseArgs(["workspace", "records", ...argv]), plugins: [] } as never);
    return { status, doc: JSON.parse(out.join("\n")) };
  };

  test("write through the one kind the declaration names", async () => {
    const root = workspace({}, []);
    const reviewed = await run(root, "review", "ref-001", "--verdict", "agree", "--by", "bob", "--dry-run");
    expect(reviewed).toMatchObject({ status: 0, doc: { path: expect.stringContaining("decisions/ref-001-"), review: { reviewer: "bob", verdict: "agree" }, dryRun: true } });
    out.length = 0;
    writeFiles(root, { "patch.json": JSON.stringify({ title: "Changed" }) });
    const amended = await run(root, "amend", "ref-001", "--set", join(root, "patch.json"), "--dry-run");
    expect(amended.doc.error?.code).not.toBe("write-usage-invalid");
  });

  test("are refused with the kinds named when the declaration names several, and --kind picks one", async () => {
    const root = workspace();
    const refused = await run(root, "review", "ref-001", "--verdict", "agree", "--by", "bob", "--dry-run");
    expect(refused.status).toBe(1);
    expect(refused.doc.error.code).toBe("write-usage-invalid");
    expect(refused.doc.error.message).toContain("the declaration names 2 record kinds (decisions/decision.kind.mjs, design/notes/note.kind.mjs), so name the one to write with --kind");
    out.length = 0;
    const picked = await run(root, "review", "ref-001", "--kind", join(root, "decisions/decision.kind.mjs"), "--verdict", "agree", "--by", "bob", "--dry-run");
    expect(picked.status).toBe(0);
    out.length = 0;
    const bare = repo({ "chant.workspace.json": decl(members()), "app/x": "", "design/x": "" });
    const none = await run(bare, "review", "ref-001", "--verdict", "agree", "--by", "bob");
    expect(none.doc.error.message).toMatch(/^--kind <kind file> is required/);
  });
});

describe("graph --intent without --kind reads every declared kind (#2680)", () => {
  const { expectValid } = contract(intentSchema);
  /** Both kinds join a commit's Unit trailer: each to its own unit, and both to one contract. */
  const joins = (unit: string, status: string) =>
    `\nexport function commitJoins(commit) {\n  const id = commit.trailers["Unit"]?.[0];\n  if (!id) return undefined;\n  return { unit: { id: "${unit}-" + id }, contract: { id: "C-1", status: "${status}" } };\n}\n`;

  test("in the declaration's order, and when two kinds join one commit both joins apply and the first kind's node data wins", async () => {
    const root = workspace({
      "decisions/decision.kind.mjs": DECISION_KIND + joins("D", "from-decisions"),
      "design/notes/note.kind.mjs": NOTE_KIND + joins("N", "from-notes"),
    });
    writeFiles(root, { "app/server.mjs": "export const port = 9090;\n" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "move the port", "-m", "Unit: U-1");
    const sha = git(root, "rev-parse", "HEAD");

    const { doc } = await intentGraph({ cwd: root, region: "app/server.mjs" });
    expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.kinds).toEqual([
      { file: "decisions/decision.kind.mjs", name: "decision", records: "decision", joins: "function" },
      { file: "design/notes/note.kind.mjs", name: "note", records: "note", joins: "function" },
    ]);
    const produced = doc.edges.filter((e) => e.kind === "produced-by" && e.from === `commit:${sha}`).map((e) => e.to);
    expect(produced).toEqual(["unit:D-U-1", "unit:N-U-1"]);
    const contractNode = doc.nodes.find((n) => n.id === "contract:C-1") as unknown as { plugin: string; data: { status: string } };
    expect(contractNode.plugin).toBe("decisions/decision.kind.mjs");
    expect(contractNode.data.status).toBe("from-decisions");

    // --kind overrides the declaration, and an empty list reads none.
    const one = await intentGraph({ cwd: root, region: "app/server.mjs", kinds: [join(root, "design/notes/note.kind.mjs")] });
    expect("error" in one.doc ? [] : one.doc.kinds.map((k) => k.name)).toEqual(["note"]);
    const none = await intentGraph({ cwd: root, region: "app/server.mjs", kinds: [] });
    expect("error" in none.doc ? null : none.doc.kinds).toEqual([]);
  });
});
