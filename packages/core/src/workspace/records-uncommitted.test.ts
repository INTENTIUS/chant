/**
 * Uncommitted records in the read contract (#3160): each record of a
 * working-tree read says whether HEAD holds it as it is, the document names
 * the branch, head and base, and `--uncommitted` lists only what HEAD
 * doesn't hold. The documents validate against records.schema.json.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, test } from "vitest";
import { CONFORMANCE_FIXTURE_DIR, UNCOMMITTED_DECISION } from "./conformance";
import { queryRecords, type RecordsDocument } from "./records-cli";
import schema from "./records.schema.json";

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const KIND = "decisions/decision.kind.mjs";

type Result = Extract<RecordsDocument, { records: unknown }>;

function result(doc: RecordsDocument): Result {
  expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf-8" }).trim();
}

const DECIDED = readFileSync(join(CONFORMANCE_FIXTURE_DIR, "decisions", "fix-001-how-the-app-is-deployed.md"), "utf-8");
/** A decided record with id `fix-<n>`. */
const decided = (n: string) => DECIDED.replace('id: "fix-001"', `id: "fix-${n}"`);
/** A proposed record with id `fix-<n>`. */
const proposed = (n: string) => UNCOMMITTED_DECISION.text.replace('id: "fix-002"', `id: "fix-${n}"`);
const file = (n: string) => `decisions/fix-${n}-a-record.md`;

/** A directory with the decision kind and its schema, and no records. */
function kindDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-records-uncommitted-")));
  scratch.push(root);
  cpSync(join(CONFORMANCE_FIXTURE_DIR, "decisions"), join(root, "decisions"), { recursive: true, filter: (src) => !src.endsWith(".md") });
  return root;
}

/** A repository whose main holds fix-001, fix-003 and fix-005, on a work branch one commit past main. */
function repository(): { root: string; main: string } {
  const root = kindDir();
  for (const n of ["001", "003", "005"]) writeFileSync(join(root, file(n)), decided(n));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "records");
  const main = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "--quiet", "-b", "chant/work/w-1");
  writeFileSync(join(root, "notes.txt"), "work\n");
  git(root, "add", "notes.txt");
  git(root, "commit", "--quiet", "-m", "work");
  return { root, main };
}

describe("records in the working tree (#3160)", () => {
  test("each record is committed, modified or new against HEAD, and the checkout names its branch, head, base and deleted records", async () => {
    const { root, main } = repository();
    writeFileSync(join(root, file("001")), `${decided("001")}\nA line kept in the working tree.\n`);
    writeFileSync(join(root, file("002")), proposed("002"));
    writeFileSync(join(root, file("004")), proposed("004"));
    git(root, "add", file("004"));
    unlinkSync(join(root, file("003")));
    const head = git(root, "rev-parse", "HEAD");

    const doc = result(await queryRecords({ kind: KIND, cwd: root }));
    expect(doc.uncommitted).toBe(false);
    expect(doc.records.map((r) => [r.id, r.worktree])).toEqual([
      ["fix-001", "modified"],
      ["fix-002", "new"],
      ["fix-004", "new"],
      ["fix-005", "committed"],
    ]);
    expect(doc.checkout).toEqual({ branch: "chant/work/w-1", head, base: main, baseFrom: "main", deleted: [file("003")] });

    const only = result(await queryRecords({ kind: KIND, cwd: root, uncommitted: true }));
    expect(only.uncommitted).toBe(true);
    expect(only.records.map((r) => [r.id, r.worktree])).toEqual([
      ["fix-001", "modified"],
      ["fix-002", "new"],
      ["fix-004", "new"],
    ]);
    expect(only.checkout).toEqual(doc.checkout);
    expect(only.summary).toEqual({ total: 3, valid: 3, invalid: 0, superseded: 0 });
  });

  test("a record changed back to what HEAD holds, or touched without a change, is committed, and the read leaves the index alone", async () => {
    const { root } = repository();
    const path = join(root, file("001"));
    writeFileSync(path, decided("001"));
    const index = join(root, ".git", "index");
    const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs };
    const doc = result(await queryRecords({ kind: KIND, cwd: root, uncommitted: true }));
    expect(doc.records).toEqual([]);
    expect(doc.checkout?.deleted).toEqual([]);
    expect(readFileSync(index).equals(before.bytes)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(before.mtime);
  });

  test("--base names the target the base is forked from", async () => {
    const { root } = repository();
    const head = git(root, "rev-parse", "HEAD");
    const doc = result(await queryRecords({ kind: KIND, cwd: root, base: "HEAD" }));
    expect(doc.checkout).toMatchObject({ head, base: head, baseFrom: "flag" });
  });

  test("a detached HEAD has no branch, and a repository with no commits has no head and only new records", async () => {
    const { root } = repository();
    git(root, "checkout", "--quiet", "--detach");
    expect(result(await queryRecords({ kind: KIND, cwd: root })).checkout?.branch).toBeNull();

    const empty = kindDir();
    writeFileSync(join(empty, file("001")), decided("001"));
    git(empty, "init", "--quiet", "--initial-branch=main");
    const doc = result(await queryRecords({ kind: KIND, cwd: empty, uncommitted: true }));
    expect(doc.checkout).toEqual({ branch: "main", head: null, base: null, baseFrom: null, deleted: [] });
    expect(doc.records.map((r) => r.worktree)).toEqual(["new"]);
  });

  test("a read at a revision has no checkout and no worktree", async () => {
    const { root } = repository();
    writeFileSync(join(root, file("002")), proposed("002"));
    const doc = result(await queryRecords({ kind: KIND, cwd: root, at: "HEAD" }));
    expect(doc.checkout).toBeUndefined();
    expect(doc.records.every((r) => r.worktree === undefined)).toBe(true);
    await expect(queryRecords({ kind: KIND, cwd: root, at: "HEAD", uncommitted: true })).rejects.toThrow(/takes no --at/);
  });

  test("outside git a read has no checkout, and --uncommitted fails with not-a-git-repository", async () => {
    const root = kindDir();
    writeFileSync(join(root, file("001")), decided("001"));
    const doc = result(await queryRecords({ kind: KIND, cwd: root }));
    expect(doc.checkout).toBeUndefined();
    expect(doc.records[0].worktree).toBeUndefined();
    const failed = await queryRecords({ kind: KIND, cwd: root, uncommitted: true });
    expect(validate(failed)).toBe(true);
    expect(failed).toMatchObject({ error: { code: "not-a-git-repository" } });
  });

  test("the schema holds an --uncommitted document to its promise", () => {
    const head = "a".repeat(40);
    const doc = {
      $schema: schema.$id,
      contract: 1,
      kind: { name: "decision", schema: "urn:x", file: KIND },
      at: null,
      current: false,
      uncommitted: true,
      checkout: { branch: "main", head, base: head, baseFrom: "main", deleted: [] },
      records: [{ id: "fix-001", path: file("001"), state: "decided", valid: true, reasons: [], supersededBy: null, remediatedBy: [], data: {}, worktree: "new" }],
      summary: { total: 1, valid: 1, invalid: 0, superseded: 0 },
    };
    expect(validate(doc)).toBe(true);
    expect(validate({ ...doc, records: [{ ...doc.records[0], worktree: "committed" }] })).toBe(false);
    const { checkout: _checkout, ...noCheckout } = doc;
    expect(validate(noCheckout)).toBe(false);
  });
});
