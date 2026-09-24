import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { lexiconModulePath } from "../lexicon-module";
import { gitRevisionSource, gitRoot, resolveRevision, workingTreeSource } from "./record-source";
import { loadRecordKind, parseFrontMatter, readRecords, RecordReadError, type LoadedRecordKind } from "./records";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const DECISIONS = join(REPO, "docs", "design", "decisions");
const SAMPLE = readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8");

/** A copy of a real decision with its id, state and supersedes links replaced. */
function decision(id: string, state = "decided", supersedes: string[] = []): string {
  const links = supersedes.length === 0 ? "supersedes: []" : `supersedes:\n${supersedes.map((d) => `  - decision: "${d}"`).join("\n")}`;
  return SAMPLE.replace(/^id: .*$/m, `id: "${id}"`)
    .replace(/^state: .*$/m, `state: "${state}"`)
    .replace(/^supersedes:(?: \[\])?\n(?:  .*\n)*/m, `${links}\n`);
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-records-")));
  mkdirSync(join(dir, "decisions"));
  cpSync(join(DECISIONS, "decision.kind.mjs"), join(dir, "decisions", "decision.kind.mjs"));
  cpSync(join(DECISIONS, "decision.schema.json"), join(dir, "decisions", "decision.schema.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, text: string): void {
  writeFileSync(join(dir, "decisions", name), text);
}

async function read(options: { current?: boolean } = {}) {
  const loaded = await loadRecordKind(join(dir, "decisions", "decision.kind.mjs"));
  return readRecords(loaded, { root: dir, source: workingTreeSource(dir), ...options });
}

const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);

describe("parseFrontMatter", () => {
  test("reads the JSON subset of YAML, whatever the line endings", () => {
    const fm = parseFrontMatter('---\r\nid: "a-001"\r\nn: 2\r\nok: true\r\nlist: []\r\n---\r\n# A\r\n');
    expect(fm).toEqual({ ok: true, value: { id: "a-001", n: 2, ok: true, list: [] } });
  });

  test("an unquoted date stays a string", () => {
    expect(parseFrontMatter("---\non: 2026-09-23\n---\n")).toEqual({ ok: true, value: { on: "2026-09-23" } });
  });

  test.each([
    ["no front matter", "# Just a heading\n", /no front matter/],
    ["an unclosed block", "---\nid: x\n", /no front matter/],
    ["invalid YAML", "---\nid: [unclosed\n---\n", /not valid YAML/],
    ["a duplicate key", "---\nid: a\nid: b\n---\n", /not valid YAML/],
    ["a list at the top", "---\n- a\n---\n", /must be a mapping/],
    ["an alias", "---\na: &x {k: 1}\nb: *x\n---\n", /aliases/],
  ])("refuses %s", (_label, text, why) => {
    const fm = parseFrontMatter(text);
    expect(fm.ok).toBe(false);
    if (!fm.ok) expect(fm.message).toMatch(why);
  });
});

describe("readRecords", () => {
  test("every well-formed decision is valid, in path order", async () => {
    write("ws-002-b.md", decision("ws-002"));
    write("ws-001-a.md", decision("ws-001"));
    write("README.md", "# not a record\n");
    const result = await read();
    expect(result.records.map((r) => [r.id, r.path, r.valid, r.state])).toEqual([
      ["ws-001", "decisions/ws-001-a.md", true, "decided"],
      ["ws-002", "decisions/ws-002-b.md", true, "decided"],
    ]);
    expect(result.summary).toEqual({ total: 2, valid: 2, invalid: 0, superseded: 0 });
    expect(result.records[0].data?.title).toBe("Seal scope");
  });

  test("a malformed file is returned with record-unparseable", async () => {
    write("ws-001-a.md", "no front matter here\n");
    const [r] = (await read()).records;
    expect(r).toMatchObject({ id: null, state: null, valid: false, data: null });
    expect(codes(r)).toEqual(["record-unparseable"]);
  });

  test("a schema violation is returned with record-schema-invalid, and keeps its data", async () => {
    write("ws-001-a.md", decision("ws-001").replace(/^state: .*$/m, 'state: "maybe"'));
    const [r] = (await read()).records;
    expect(codes(r)).toEqual(["record-schema-invalid"]);
    expect(r.reasons[0].message).toMatch(/\/state/);
    expect(r.id).toBe("ws-001");
    expect(r.data).not.toBeNull();
  });

  test("a supersedes link to a missing id is record-supersedes-unknown", async () => {
    write("ws-002-b.md", decision("ws-002", "decided", ["ws-404"]));
    const [r] = (await read()).records;
    expect(codes(r)).toEqual(["record-supersedes-unknown"]);
  });

  test("a repeated id is flagged on the later file only", async () => {
    write("ws-001-a.md", decision("ws-001"));
    write("ws-001-b.md", decision("ws-001"));
    const records = (await read()).records;
    expect(records.map(codes)).toEqual([[], ["record-id-duplicate"]]);
  });

  test("supersession comes from a closed record's link, never from the old record's own state", async () => {
    write("ws-001-a.md", decision("ws-001", "superseded"));
    write("ws-002-b.md", decision("ws-002", "ratified"));
    write("ws-003-c.md", decision("ws-003", "ratified"));
    write("ws-004-d.md", decision("ws-004", "ratified", ["ws-003"]));
    const all = await read();
    expect(all.records.map((r) => [r.id, r.supersededBy])).toEqual([
      ["ws-001", null],
      ["ws-002", null],
      ["ws-003", "ws-004"],
      ["ws-004", null],
    ]);
    expect(all.summary.superseded).toBe(1);
    const current = await read({ current: true });
    expect(current.records.map((r) => r.id)).toEqual(["ws-001", "ws-002", "ws-004"]);
  });

  test("a link from a decided record does not supersede yet", async () => {
    write("ws-001-a.md", decision("ws-001", "ratified"));
    write("ws-002-b.md", decision("ws-002", "decided", ["ws-001"]));
    const current = await read({ current: true });
    expect(current.records.map((r) => [r.id, r.valid])).toEqual([
      ["ws-001", true],
      ["ws-002", true],
    ]);
  });

  test("a decided record supersedes a decided one, under an equal approval rule (#2524 D4)", async () => {
    write("ws-001-a.md", decision("ws-001", "decided"));
    write("ws-002-b.md", decision("ws-002", "decided", ["ws-001"]));
    const all = await read();
    expect(all.records.map((r) => [r.id, r.supersededBy, r.valid, r.warnings])).toEqual([
      ["ws-001", "ws-002", true, []],
      ["ws-002", null, true, []],
    ]);
    const current = await read({ current: true });
    expect(current.records.map((r) => r.id)).toEqual(["ws-002"]);
  });

  test("a proposed record supersedes nothing: the link is pending, as a warning on the new record", async () => {
    write("ws-001-a.md", decision("ws-001", "decided"));
    write("ws-002-b.md", decision("ws-002", "proposed", ["ws-001"]).replace(/^choice:\n  option: .*\n  reason: .*\n/m, "choice: null\n"));
    const all = await read();
    expect(all.records.map((r) => [r.id, r.supersededBy, r.valid])).toEqual([
      ["ws-001", null, true],
      ["ws-002", null, true],
    ]);
    expect(all.records[1].warnings.map((w) => w.code)).toEqual(["record-supersedes-pending"]);
    expect((await read({ current: true })).records.map((r) => r.id)).toEqual(["ws-001", "ws-002"]);
  });

  test("a decided record can't supersede a ratified one; a ratified record supersedes any", async () => {
    write("ws-001-a.md", decision("ws-001", "ratified"));
    write("ws-002-b.md", decision("ws-002", "decided", ["ws-001"]));
    write("ws-003-c.md", decision("ws-003", "decided"));
    write("ws-004-d.md", decision("ws-004", "ratified", ["ws-003"]));
    const all = await read();
    expect(all.records.map((r) => [r.id, r.supersededBy, r.warnings.map((w) => w.code)])).toEqual([
      ["ws-001", null, []],
      ["ws-002", null, ["record-supersedes-pending"]],
      ["ws-003", "ws-004", []],
      ["ws-004", null, []],
    ]);
  });

  test("a kind without approval ranks keeps the closed-state rule", async () => {
    const kind = readFileSync(join(dir, "decisions", "decision.kind.mjs"), "utf-8").replace(/^  approval: .*\n/m, "");
    writeFileSync(join(dir, "decisions", "decision.kind.mjs"), kind);
    write("ws-001-a.md", decision("ws-001", "decided"));
    write("ws-002-b.md", decision("ws-002", "decided", ["ws-001"]));
    const all = await read();
    expect(all.records.map((r) => [r.id, r.supersededBy, r.warnings])).toEqual([
      ["ws-001", null, []],
      ["ws-002", null, []],
    ]);
  });

  test("a record superseded twice keeps the first and flags the second", async () => {
    write("ws-001-a.md", decision("ws-001", "ratified"));
    write("ws-002-b.md", decision("ws-002", "ratified", ["ws-001"]));
    write("ws-003-c.md", decision("ws-003", "ratified", ["ws-001"]));
    const records = (await read()).records;
    expect(records[0].supersededBy).toBe("ws-002");
    expect(codes(records[2])).toEqual(["record-supersedes-conflict"]);
  });

  test("a missing records directory is location-missing", async () => {
    const loaded = await loadRecordKind(join(dir, "decisions", "decision.kind.mjs"));
    const moved: LoadedRecordKind = { ...loaded, dir: join(dir, "nowhere") };
    await expect(readRecords(moved, { root: dir, source: workingTreeSource(dir) })).rejects.toMatchObject({ code: "location-missing" });
  });
});

/**
 * A decision made in the workspace (#2654): the workspace source form with no
 * issue, and no evidence. `constrains` replaces ws-003's.
 */
function workspaceDecision(id: string, constrains: string[] = ["member:app"]): string {
  const list = constrains.length === 0 ? "constrains: []\n" : `constrains:\n${constrains.map((c) => `  - "${c}"\n`).join("")}`;
  return decision(id)
    .replace(/^source:\n(?:  .*\n)*/m, 'source:\n  kind: "workspace"\n  member: "app"\n')
    .replace(/^evidence:\n(?:  .*\n)*/m, "evidence: []\n")
    .replace(/^constrains:\n(?:  .*\n)*/m, list);
}

describe("a decision that originates in the workspace (#2654)", () => {
  test("validates with no issue and no evidence, is current, and carries record-no-evidence", async () => {
    write("ws-001-a.md", workspaceDecision("ws-001"));
    const current = await read({ current: true });
    expect(current.records.map((r) => [r.id, r.valid, r.reasons, r.warnings.map((w) => w.code)])).toEqual([
      ["ws-001", true, [], ["record-no-evidence"]],
    ]);
    expect(current.records[0].data?.source).toEqual({ kind: "workspace", member: "app" });
  });

  test("takes a session and an issue, and nothing else", async () => {
    const base = workspaceDecision("ws-001");
    write("ws-001-a.md", base.replace('  member: "app"\n', '  member: "app"\n  session: "S-0001"\n  issue: "jhgaylor/chud#77"\n'));
    write("ws-002-b.md", base.replace('id: "ws-001"', 'id: "ws-002"').replace('  member: "app"\n', '  member: "app"\n  session: null\n'));
    write("ws-003-c.md", base.replace('id: "ws-001"', 'id: "ws-003"').replace('  member: "app"\n', '  member: "app"\n  row: "Sort order"\n'));
    write("ws-004-d.md", base.replace('id: "ws-001"', 'id: "ws-004"').replace('  member: "app"\n', ""));
    const records = (await read()).records;
    expect(records.map((r) => [r.id, codes(r)])).toEqual([
      ["ws-001", []],
      ["ws-002", []],
      ["ws-003", ["record-schema-invalid"]],
      ["ws-004", ["record-schema-invalid"]],
    ]);
  });

  test("a record with evidence carries no record-no-evidence warning", async () => {
    write("ws-001-a.md", decision("ws-001"));
    expect((await read()).records[0].warnings).toEqual([]);
  });

  test("a record that constrains nothing is refused", async () => {
    write("ws-001-a.md", workspaceDecision("ws-001", []));
    const [r] = (await read()).records;
    expect(codes(r)).toEqual(["record-schema-invalid"]);
    expect(r.reasons[0].message).toMatch(/constrains/);
  });
});

describe("loadRecordKind", () => {
  const load = () => loadRecordKind(join(dir, "decisions", "decision.kind.mjs"));

  test("the chant repo's decision kind loads with its schema", async () => {
    const loaded = await loadRecordKind(join(DECISIONS, "decision.kind.mjs"));
    expect(loaded.kind.name).toBe("decision");
    expect(loaded.schema.$id).toBe("urn:intentius:chant:decision:1");
    expect(loaded.dir).toBe(DECISIONS);
  });

  test("loads through the #2520 path loader and leaves nothing registered", async () => {
    const file = join(DECISIONS, "decision.kind.mjs");
    await loadRecordKind(file);
    expect(lexiconModulePath(`record-kind:${file}`)).toBeUndefined();
  });

  test("a missing file is kind-unreadable", async () => {
    await expect(loadRecordKind(join(dir, "none.kind.ts"))).rejects.toMatchObject({ code: "kind-unreadable" });
  });

  test("a module with no recordKind is kind-invalid", async () => {
    writeFileSync(join(dir, "decisions", "decision.kind.mjs"), "export const other = 1;\n");
    await expect(load()).rejects.toMatchObject({ code: "kind-invalid" });
  });

  test("an unknown field or a closed state outside states is kind-invalid", async () => {
    const text = readFileSync(join(DECISIONS, "decision.kind.mjs"), "utf-8");
    writeFileSync(join(dir, "decisions", "decision.kind.mjs"), text.replace('closedStates: ["ratified", "superseded"]', 'closedStates: ["sealed"]'));
    await expect(load()).rejects.toMatchObject({ code: "kind-invalid" });
  });

  test("a schema whose $id differs is schema-id-mismatch", async () => {
    const schema = JSON.parse(readFileSync(join(DECISIONS, "decision.schema.json"), "utf-8"));
    writeFileSync(join(dir, "decisions", "decision.schema.json"), JSON.stringify({ ...schema, $id: "urn:other" }));
    await expect(load()).rejects.toMatchObject({ code: "schema-id-mismatch" });
  });

  test("an unreadable schema is schema-unreadable", async () => {
    writeFileSync(join(dir, "decisions", "decision.schema.json"), "{ not json");
    await expect(load()).rejects.toBeInstanceOf(RecordReadError);
    await expect(load()).rejects.toMatchObject({ code: "schema-unreadable" });
  });
});

describe("reading at a revision", () => {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
    }).trim();

  test("reads the committed files, not the working tree", async () => {
    write("ws-001-a.md", decision("ws-001"));
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const first = git("rev-parse", "HEAD");
    write("ws-002-b.md", decision("ws-002"));
    write("ws-001-a.md", "broken now\n");

    expect(gitRoot(join(dir, "decisions"))).toBe(dir);
    const loaded = await loadRecordKind(join(dir, "decisions", "decision.kind.mjs"));
    const at = await readRecords(loaded, { root: dir, source: gitRevisionSource(dir, resolveRevision(dir, "main")) });
    expect(at.records.map((r) => [r.id, r.valid])).toEqual([["ws-001", true]]);
    expect(resolveRevision(dir, first.slice(0, 8))).toBe(first);

    const tree = await readRecords(loaded, { root: dir, source: workingTreeSource(dir) });
    expect(tree.records.map((r) => [r.path, r.valid])).toEqual([
      ["decisions/ws-001-a.md", false],
      ["decisions/ws-002-b.md", true],
    ]);
  });

  test("an unknown revision is revision-unknown, and a directory missing at the revision is location-missing", async () => {
    write("ws-001-a.md", decision("ws-001"));
    writeFileSync(join(dir, "other.txt"), "x\n");
    git("init", "-q", "-b", "main");
    git("add", "other.txt");
    git("commit", "-q", "-m", "no records yet");
    expect(() => resolveRevision(dir, "no-such-ref")).toThrow(expect.objectContaining({ code: "revision-unknown" }));
    expect(() => resolveRevision(dir, "--all")).toThrow(expect.objectContaining({ code: "revision-unknown" }));
    const loaded = await loadRecordKind(join(dir, "decisions", "decision.kind.mjs"));
    await expect(
      readRecords(loaded, { root: dir, source: gitRevisionSource(dir, resolveRevision(dir, "HEAD")) }),
    ).rejects.toMatchObject({ code: "location-missing" });
  });

  test("outside a repository there is no git root", () => {
    expect(gitRoot(dir)).toBeUndefined();
  });
});
