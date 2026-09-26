/**
 * The forward coverage check (#2773): `chant workspace check --changes`, on a
 * workspace built in a throwaway git repository.
 *
 * - c0 declares members app and docs, a changes block that ignores lockfiles
 *   and app/dist, and these records:
 *   - dec-001, decided: constrains `path:app/src`, puts `app/src/vendor` out of scope;
 *   - dec-002, proposed: constrains `path:docs`, so it covers nothing yet;
 *   - W-001, in progress, implements dec-001: constrains `path:app/lib`, puts
 *     `app/lib/legacy.mjs` out of scope;
 *   - W-002, done: constrains `path:tools`, so it covers nothing any more.
 * - c1 changes a covered file, a file only a proposed decision names, a file
 *   only a done item names, a lockfile, a file under dist, a file dec-001
 *   puts out of scope, a file W-001 puts out of scope, and adds the work item
 *   W-003, a record file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { changeFindingSource, checkChanges, CHANGES_FINDING_CODES, workBranchChanges, type ChangesDocument } from "./changes";
import { formatChanges } from "./changes-cli";
import { changeCoverage } from "../op/activities/change-coverage";
import changesSchema from "./changes.schema.json";
import { parseFrontMatter } from "./records";
import { REASONS } from "./reason-codes";

const REF = join(REPO, "reference-workspace");
const DECISION = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "decisions", "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

function decision(id: string, fields: { state?: string; constrains: string[]; out_of_scope?: string[] }): string {
  const proposed = fields.state === "proposed";
  const data = {
    ...DECISION,
    id,
    title: `Decision ${id}`,
    state: fields.state ?? "decided",
    supersedes: [],
    evidence: [],
    constrains: fields.constrains,
    ...(fields.out_of_scope ? { out_of_scope: fields.out_of_scope } : {}),
    ...(proposed ? { choice: null, decided_by: null, decided_on: null } : {}),
  };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

function work(id: string, fields: Record<string, unknown>): string {
  const data = { schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: ["path:app/lib"], evidence: [], opened_on: "2026-09-25", source: { kind: "workspace", member: "app" }, supersedes: [], ...fields };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

// The work schema is draft-07, like the decision schema.
const workSchema = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(join(REF, "work", "work.schema.json"), "utf-8")) as object);
const changes = contract(changesSchema);
type Result = Exclude<ChangesDocument, { error: unknown }>;

let root: string;
const sha: Record<string, string> = {};

function commit(message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function declaration(changesBlock: Record<string, unknown>): string {
  return JSON.stringify(
    {
      name: "studio",
      schema: 1,
      members: [
        { name: "app", dir: "app", kind: "other", because: "a plain Node server" },
        { name: "docs", dir: "docs", kind: "other", because: "prose" },
      ],
      records: [{ kind: "decisions/decision.kind.mjs" }, { kind: "work/work.kind.mjs" }],
      changes: changesBlock,
    },
    null,
    2,
  );
}

beforeAll(() => {
  root = repo({
    "chant.workspace.json": declaration({ ignore: ["**/package-lock.json", "app/dist/**"] }),
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "decisions/dec-001-server.md": decision("dec-001", { constrains: ["path:app/src"], out_of_scope: ["app/src/vendor"] }),
    "decisions/dec-002-docs.md": decision("dec-002", { state: "proposed", constrains: ["path:docs"] }),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "work/W-001-lib.md": work("W-001", { state: "in-progress", implements: ["dec-001"], out_of_scope: ["app/lib/legacy.mjs"] }),
    "work/W-002-tools.md": work("W-002", { state: "done", closed_on: "2026-09-25", constrains: ["path:tools"], evidence: [{ title: "The run", url: "https://example.com/run" }] }),
    "app/src/server.mjs": "export const port = 8080;\n",
    "app/src/vendor/lib.mjs": "export const v = 1;\n",
    "app/lib/a.mjs": "export const a = 1;\n",
    "app/lib/legacy.mjs": "export const legacy = 1;\n",
    "app/package-lock.json": "{}\n",
    "app/dist/out.js": "1;\n",
    "docs/readme.md": "# Docs\n",
    "tools/t.mjs": "export const t = 1;\n",
  });
  sha.c0 = commit("the workspace");
  writeFiles(root, {
    "app/src/server.mjs": "export const port = 9090;\n",
    "app/src/vendor/lib.mjs": "export const v = 2;\n",
    "app/lib/legacy.mjs": "export const legacy = 2;\n",
    "app/package-lock.json": '{ "lockfileVersion": 3 }\n',
    "app/dist/out.js": "2;\n",
    "docs/readme.md": "# Docs, edited\n",
    "tools/t.mjs": "export const t = 2;\n",
    "work/W-003-next.md": work("W-003", { constrains: ["path:app/lib/a.mjs"] }),
  });
  sha.c1 = commit("the change");
});
afterAll(cleanScratch);

async function check(range: string, options: { work?: string; severity?: "off" | "warn" | "fail" } = {}): Promise<{ doc: Result; failed: boolean }> {
  const { doc, failed } = await checkChanges({ cwd: root, range, ...options });
  changes.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return { doc, failed };
}

const statusOf = (doc: Result) => Object.fromEntries(doc.paths.map((p) => [p.path, p.status]));

describe("the forward coverage check (#2773)", () => {
  test("maps each changed path to the current records covering it: covered, uncovered, out of scope, ignored and record", async () => {
    const { doc, failed } = await check(`${sha.c0}..${sha.c1}`);
    expect(failed).toBe(false);
    expect(doc.range).toEqual({ spec: `${sha.c0}..${sha.c1}`, base: sha.c0, head: sha.c1 });
    expect(doc.severity).toBe("warn");
    expect(doc.kinds).toEqual([
      { file: "decisions/decision.kind.mjs", name: "decision", role: "decision" },
      { file: "work/work.kind.mjs", name: "work", role: "work" },
    ]);
    expect(statusOf(doc)).toEqual({
      "app/dist/out.js": "ignored",
      "app/lib/legacy.mjs": "out-of-scope",
      "app/package-lock.json": "ignored",
      "app/src/server.mjs": "covered",
      "app/src/vendor/lib.mjs": "out-of-scope",
      "docs/readme.md": "uncovered",
      "tools/t.mjs": "uncovered",
      "work/W-003-next.md": "record",
    });
    const server = doc.paths.find((p) => p.path === "app/src/server.mjs")!;
    expect(server).toMatchObject({ change: "modified", member: "app", coveredBy: [{ record: "decision/dec-001", state: "decided", entry: "path:app/src" }] });
    expect(doc.paths.find((p) => p.path === "app/package-lock.json")!.ignoredBy).toBe("**/package-lock.json");
    expect(doc.paths.find((p) => p.path === "app/src/vendor/lib.mjs")!.outOfScopeBy).toEqual([{ record: "decision/dec-001", state: "decided", entry: "app/src/vendor" }]);
    expect(doc.paths.find((p) => p.path === "app/lib/legacy.mjs")!.outOfScopeBy).toEqual([{ record: "work/W-001", state: "in-progress", entry: "app/lib/legacy.mjs" }]);
    expect(doc.findings.map((f) => [f.code, f.path])).toEqual([
      ["change-out-of-scope", "app/lib/legacy.mjs"],
      ["change-out-of-scope", "app/src/vendor/lib.mjs"],
      ["change-uncovered", "docs/readme.md"],
      ["change-uncovered", "tools/t.mjs"],
    ]);
    expect(doc.findings.every((f) => f.severity === "warn")).toBe(true);
    expect(doc.summary).toEqual({ paths: 8, covered: 1, uncovered: 2, outOfScope: 2, ignored: 2, records: 1 });
    expect(doc.ok).toBe(true);
    const text = formatChanges(doc);
    expect(text).toContain("uncovered    modified docs/readme.md");
    expect(text).toContain("warning   change-out-of-scope: app/src/vendor/lib.mjs is modified, and decision/dec-001 (app/src/vendor) puts it out of scope");
  });

  test("with --work, the records in hand are the item and the decisions it implements", async () => {
    const { doc } = await check(`${sha.c0}..${sha.c1}`, { work: "W-001" });
    expect(doc.work).toEqual({ record: "work/W-001", state: "in-progress" });
    expect(statusOf(doc)["app/lib/legacy.mjs"]).toBe("out-of-scope");
    expect(statusOf(doc)["app/src/vendor/lib.mjs"]).toBe("out-of-scope");
    // W-002 is done, so nothing it puts out of scope counts, and nothing it constrains is covered.
    const { doc: done } = await check(`${sha.c0}..${sha.c1}`, { work: "W-002" });
    expect(statusOf(done)["app/lib/legacy.mjs"]).toBe("uncovered");
    expect(statusOf(done)["app/src/vendor/lib.mjs"]).toBe("uncovered");
    expect(statusOf(done)["app/src/server.mjs"]).toBe("covered");
  });

  test("severity: fail fails on a finding, off reports none, and the declaration sets the default", async () => {
    const fail = await check(`${sha.c0}..${sha.c1}`, { severity: "fail" });
    expect(fail.failed).toBe(true);
    expect(fail.doc.ok).toBe(false);
    expect(fail.doc.findings.every((f) => f.severity === "fail")).toBe(true);
    const off = await check(`${sha.c0}..${sha.c1}`, { severity: "off" });
    expect(off.failed).toBe(false);
    expect(off.doc.findings).toEqual([]);
    expect(statusOf(off.doc)["docs/readme.md"]).toBe("uncovered");

    writeFiles(root, { "chant.workspace.json": declaration({ severity: "fail", ignore: ["**/package-lock.json", "app/dist/**"] }) });
    const c2 = commit("fail on a gap");
    const declared = await check(`${sha.c0}..${c2}`);
    expect(declared.doc.severity).toBe("fail");
    expect(declared.failed).toBe(true);
    // The declaration itself changed, and no record covers it.
    expect(statusOf(declared.doc)["chant.workspace.json"]).toBe("uncovered");
    git(root, "reset", "-q", "--hard", sha.c1);
  });

  test("a range with no change, a head alone, and a merge base", async () => {
    const empty = await check(`${sha.c1}..${sha.c1}`);
    expect(empty.doc.paths).toEqual([]);
    expect(empty.doc.findings).toEqual([]);
    const toHead = await check(sha.c0);
    expect(toHead.doc.range.head).toBe(sha.c1);
    expect(toHead.doc.paths).toHaveLength(8);
    const merge = await check(`${sha.c0}...${sha.c1}`);
    expect(merge.doc.range.base).toBe(sha.c0);
  });

  test("an unknown revision or work item is an error document", async () => {
    const bad = await checkChanges({ cwd: root, range: "nope..HEAD" });
    changes.expectValid(bad.doc);
    expect(bad.failed).toBe(true);
    expect("error" in bad.doc && bad.doc.error.code).toBe("revision-unknown");
    const unknown = await checkChanges({ cwd: root, range: `${sha.c0}..${sha.c1}`, work: "W-999" });
    changes.expectValid(unknown.doc);
    expect("error" in unknown.doc && unknown.doc.error.code).toBe("work-item-unknown");
  });

  test("a finding's triage is the source a work item seeded from it takes (#2741's seam)", async () => {
    const { doc } = await check(`${sha.c0}..${sha.c1}`);
    for (const f of doc.findings) {
      expect(f.triage).toEqual(changeFindingSource(f));
      const seeded = parseFrontMatter(work("W-010", { constrains: [`path:${f.path}`], source: f.triage }));
      if (!seeded.ok) throw new Error(seeded.message);
      expect(workSchema(seeded.value), JSON.stringify(workSchema.errors)).toBe(true);
    }
    for (const c of CHANGES_FINDING_CODES) expect(REASONS[c].length).toBeGreaterThan(10);
  });

  test("on a work branch, the range and the item come from the branch (an Op under changesCheckout)", async () => {
    const tree = join(root, ".git", "chant-work", "W-001");
    git(root, "worktree", "add", "-q", "-b", "chant/work/W-001", tree, "HEAD");
    writeFiles(tree, { "app/lib/a.mjs": "export const a = 2;\n", "docs/readme.md": "# Docs, again\n" });
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "the work");
    expect(workBranchChanges(root)).toBeUndefined();
    const found = workBranchChanges(tree)!;
    expect(found).toEqual({ range: `${sha.c1}..HEAD`, work: "W-001" });
    const { doc } = await checkChanges({ cwd: tree, ...found });
    changes.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(statusOf(doc)).toEqual({ "app/lib/a.mjs": "covered", "docs/readme.md": "uncovered" });
    // The Op activity reads the same from the worktree, and fails the step at severity fail.
    const step = await changeCoverage({ cwd: tree });
    expect(step).toMatchObject({ ok: true, work: "work/W-001", severity: "warn", summary: { paths: 2, covered: 1, uncovered: 1 } });
    expect(step.findings).toEqual([expect.objectContaining({ code: "change-uncovered", path: "docs/readme.md", triage: { finding: "change-uncovered", region: "docs/readme.md" } })]);
    await expect(changeCoverage({ cwd: tree, severity: "fail" })).rejects.toThrow(/1 change finding at severity fail: change-uncovered docs\/readme.md/);
    await expect(changeCoverage({ cwd: root })).rejects.toThrow(/not on a chant\/work\/ branch/);
    git(root, "worktree", "remove", "--force", tree);
  });
});
