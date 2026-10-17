/**
 * Which work item a commit belongs to (#4029): the one judgement, and where
 * `workspace check --changes`, `ci list` and `ci tick` report it.
 *
 * - c0 declares the workspace, the decision s-001 and the work items W-001
 *   and W-002, and a ci.green block.
 * - c1 carries Chant-Record: work:W-001.
 * - c2 carries only a Chant-Lease, whose token the lease history of W-002
 *   on chant/lifecycle names.
 * - c3 carries nothing.
 * - c4 names work:W-999, which no record has.
 * - c5 names decision:s-001, a record of a kind that is not the work kind.
 * - c6 carries a Chant-Lease no lease history names.
 * - c7 carries a Chant-Record that is not <kind>:<id>.
 * - c8 names decision:s-001 and work:W-002, so the decision beside the work
 *   item changes nothing.
 * - m is a merge of a branch whose commit is not on the first-parent line.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { writeBlobToPath } from "../lifecycle/git";
import { cleanScratch, contract, git, REPO, repo, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { checkChanges, type ChangesDocument } from "./changes";
import { formatChanges } from "./changes-cli";
import changesSchema from "./changes.schema.json";
import { judgeCommitLink, type WorkIndex } from "./commit-links";
import { ciList, ciTick, formatList, formatTick, whyWorkUnknown, type CiListDocument } from "./ci-green";
import type { CiForge } from "./ci-green-forge";
import ciListSchema from "./ci-list.schema.json";
import { parseFrontMatter } from "./records";

const REF = join(REPO, "reference-workspace");
const DECISION = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "decisions", "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

const decision = (id: string) => `---\n${JSON.stringify({ ...DECISION, id, title: `Decision ${id}`, state: "decided", supersedes: [], evidence: [], constrains: ["path:app"] }, null, 2)}\n---\n\n# ${id}\n`;
const work = (id: string) => `---\n${JSON.stringify({ schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: ["path:app"], evidence: [], opened_on: "2026-10-01", source: { kind: "workspace", member: "app" }, supersedes: [] }, null, 2)}\n---\n\n# ${id}\n`;

const TOKEN = "7a1e5c90-lease-token";
const NOW = new Date("2026-10-01T13:00:00Z");
const changes = contract(changesSchema);
const list = contract(ciListSchema);
type Result = Exclude<ChangesDocument, { error: unknown }>;
type Listed = Extract<CiListDocument, { branch: string }>;

let root: string;
let origin: string;
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

function edit(name: string, message: string[]): string {
  writeFiles(root, { "app/main.js": `export const n = ${tick};\n` });
  return (sha[name] = commit(message));
}

beforeAll(async () => {
  root = repo({
    "chant.workspace.json": JSON.stringify({
      name: "links",
      schema: 1,
      members: [{ name: "app", dir: "app", kind: "other", because: "the app" }],
      records: [{ kind: "decisions/decision.kind.mjs" }, { kind: "work/work.kind.mjs" }],
      ci: { green: { branch: "main", phases: { lint: ["lint"] }, require: ["lint"] } },
    }),
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "decisions/s-001-app.md": decision("s-001"),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "work/W-001-one.md": work("W-001"),
    "work/W-002-two.md": work("W-002"),
    "app/main.js": "export const n = 0;\n",
  });
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  sha.c0 = commit(["the workspace"]);
  edit("c1", ["one", "Chant-Record: work:W-001"]);
  edit("c2", ["two", `Chant-Lease: ${TOKEN}`]);
  edit("c3", ["three"]);
  edit("c4", ["four", "Chant-Record: work:W-999"]);
  edit("c5", ["five", "Chant-Record: decision:s-001"]);
  edit("c6", ["six", "Chant-Lease: no-such-token"]);
  edit("c7", ["seven", "Chant-Record: nonsense"]);
  edit("c8", ["eight", "Chant-Record: decision:s-001\nChant-Record: work:W-002"]);
  git(root, "checkout", "-q", "-b", "side");
  writeFiles(root, { "app/side.js": "export const side = 1;\n" });
  commit(["on a side branch"]);
  git(root, "checkout", "-q", "main");
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = "2026-10-01T12:30:00Z";
  try {
    git(root, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
  } finally {
    delete process.env.GIT_AUTHOR_DATE;
    delete process.env.GIT_COMMITTER_DATE;
  }
  sha.m = git(root, "rev-parse", "HEAD");
  const line = { version: 1, event: "claim", item: "W-002", holder: "factory", by: "factory", token: TOKEN, acquiredAt: "2026-10-01T12:00:00Z", expiresAt: "2026-10-01T12:10:00Z", timestamp: "2026-10-01T12:00:00Z" };
  await writeBlobToPath("_leases", "W-002.jsonl", JSON.stringify(line), "Work lease claim: W-002", { cwd: root });
});
afterAll(cleanScratch);

const RANGE = () => `${sha.c0}..${sha.m}`;

async function check(severity?: "off" | "warn" | "fail"): Promise<{ doc: Result; failed: boolean }> {
  const { doc, failed } = await checkChanges({ cwd: root, range: RANGE(), ...(severity ? { severity } : {}) });
  changes.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return { doc, failed };
}

describe("judging one commit's trailers", () => {
  const index: WorkIndex = { kinds: new Map([["work", new Set(["W-1", "W-2"])]]), ledger: true };
  const none = { records: [], lease: null };

  test("a Chant-Record of a work kind with that record links, whatever else the commit names", () => {
    expect(judgeCommitLink({ "Chant-Record": ["work:W-1"] }, { records: [{ kind: "work", id: "W-1" }], lease: null }, index)).toEqual({ state: "linked", ids: ["work:W-1"], problems: [] });
    const both = judgeCommitLink({ "chant-record": ["decision:d-1", "work:W-2", "work:W-404"] }, { records: [{ kind: "decision", id: "d-1" }, { kind: "work", id: "W-2" }, { kind: "work", id: "W-404" }], lease: null }, index);
    expect(both).toEqual({ state: "linked", ids: ["work:W-2"], problems: [] });
  });

  test("a Chant-Lease links through the work item its history names", () => {
    expect(judgeCommitLink({ "Chant-Lease": ["t"] }, { records: [], lease: { token: "t", item: "W-2" } }, index)).toMatchObject({ state: "linked", ids: ["work:W-2"] });
    expect(judgeCommitLink({ "Chant-Lease": ["t"] }, { records: [], lease: { token: "t", item: "W-404" } }, index)).toMatchObject({ state: "wrong" });
    expect(judgeCommitLink({ "Chant-Lease": ["t"] }, { records: [], lease: { token: "t", item: null } }, index)).toMatchObject({ state: "wrong" });
  });

  test("a lease is not judged where the lease histories are not there to read", () => {
    const link = judgeCommitLink({ "Chant-Lease": ["t"] }, { records: [], lease: { token: "t", item: null } }, { ...index, ledger: false });
    expect(link).toEqual({ state: "linked", ids: [], problems: [] });
  });

  test("a commit with no trailer is unlinked, and a window match is not a trailer", () => {
    expect(judgeCommitLink({}, none, index)).toEqual({ state: "unlinked", ids: [], problems: [] });
    expect(judgeCommitLink({ "Chant-Agent": ["factory"], "Chant-Run": ["r-1"] }, none, index).state).toBe("unlinked");
  });

  test("each wrongly linked case says which trailer and why", () => {
    const wrong = (value: string, ref: { kind: string; id: string } | null) => judgeCommitLink({ "Chant-Record": [value] }, { records: ref ? [ref] : [], lease: null }, index);
    expect(wrong("work:W-9", { kind: "work", id: "W-9" })).toEqual({ state: "wrong", ids: [], problems: [{ trailer: "Chant-Record: work:W-9", message: "the work kind has no record W-9" }] });
    expect(wrong("decision:d-1", { kind: "decision", id: "d-1" }).problems[0].message).toBe("decision is not a work kind (the work kinds are work)");
    expect(wrong("nonsense", null).problems[0]).toEqual({ trailer: "Chant-Record: nonsense", message: "nonsense is not <kind>:<id>" });
  });
});

describe("workspace check --changes (#4029)", () => {
  test("judges the first-parent commits of the range, merges left out", async () => {
    const { doc, failed } = await check();
    expect(failed).toBe(false);
    expect(doc.links!.kinds).toEqual(["work"]);
    expect(doc.links!.commits.map((c) => [c.commit, c.state, c.ids])).toEqual([
      [sha.c1, "linked", ["work:W-001"]],
      [sha.c2, "linked", ["work:W-002"]],
      [sha.c3, "unlinked", []],
      [sha.c4, "wrong", []],
      [sha.c5, "wrong", []],
      [sha.c6, "wrong", []],
      [sha.c7, "wrong", []],
      [sha.c8, "linked", ["work:W-002"]],
    ]);
    expect(doc.links!.commits.find((c) => c.commit === sha.c4)!.problems).toEqual([{ trailer: "Chant-Record: work:W-999", message: "the work kind has no record W-999" }]);
    expect(doc.links!.commits.find((c) => c.commit === sha.c5)!.problems[0].message).toContain("decision is not a work kind");
    expect(doc.links!.commits.find((c) => c.commit === sha.c6)!.problems).toEqual([{ trailer: "Chant-Lease: no-such-token", message: "no lease history on chant/lifecycle names this token" }]);
    expect(doc.links!.commits.find((c) => c.commit === sha.c7)!.problems[0].trailer).toBe("Chant-Record: nonsense");
  });

  test("reports an unlinked commit and each wrongly linked one with a fix line, at warn by default", async () => {
    const { doc } = await check();
    expect(doc.links!.findings.map((f) => [f.code, f.commit, f.severity])).toEqual([
      ["commit-unlinked", sha.c3, "warn"],
      ["commit-wrongly-linked", sha.c4, "warn"],
      ["commit-wrongly-linked", sha.c5, "warn"],
      ["commit-wrongly-linked", sha.c6, "warn"],
      ["commit-wrongly-linked", sha.c7, "warn"],
    ]);
    expect(doc.links!.findings[0].id).toBe(`finding:commit-unlinked:${sha.c3}`);
    expect(doc.links!.findings.every((f) => f.fix.includes("Chant-Record"))).toBe(true);
    expect(doc.ok).toBe(true);
    const text = formatChanges(doc);
    expect(text).toContain("links     8 commits: 3 name a work item, 1 do not, 4 name one that is not there; work kinds: work");
    expect(text).toContain(`warning   commit-unlinked: ${sha.c3.slice(0, 8)} "three" carries no Chant-Record trailer of a work kind and no Chant-Lease trailer`);
    expect(text).toContain("          fix: add a `Chant-Record: work:<id>` trailer");
    expect(text).toContain(`commit-wrongly-linked: ${sha.c4.slice(0, 8)} "four" names no work item that exists: Chant-Record: work:W-999 (the work kind has no record W-999)`);
  });

  test("--severity sets the level: fail fails the check, off reports no finding", async () => {
    const fail = await check("fail");
    expect(fail.failed).toBe(true);
    expect(fail.doc.ok).toBe(false);
    expect(fail.doc.links!.findings.every((f) => f.severity === "fail")).toBe(true);
    expect(formatChanges(fail.doc)).toContain("error     commit-unlinked");
    const off = await check("off");
    expect(off.failed).toBe(false);
    expect(off.doc.links!.findings).toEqual([]);
    expect(off.doc.links!.commits).toHaveLength(8);
  });

  test("a range whose commits all name a work item has no finding", async () => {
    const { doc } = await checkChanges({ cwd: root, range: `${sha.c0}..${sha.c2}` });
    changes.expectValid(doc);
    expect((doc as Result).links!.findings).toEqual([]);
  });
});

describe("ci list and ci tick (#4029)", () => {
  test("ci list --json marks each commit with its link, and merges as merge", async () => {
    const doc = (await ciList({ cwd: root, now: NOW })) as Listed;
    list.expectValid(doc);
    const byCommit = Object.fromEntries(doc.commits.map((c) => [c.sha, c.work]));
    expect(byCommit[sha.c1]).toEqual({ state: "linked", ids: ["work:W-001"], problems: [] });
    expect(byCommit[sha.c2]).toMatchObject({ state: "linked", ids: ["work:W-002"] });
    expect(byCommit[sha.c3]).toEqual({ state: "unlinked", ids: [], problems: [] });
    expect(byCommit[sha.c4]).toMatchObject({ state: "wrong" });
    expect(byCommit[sha.m]).toEqual({ state: "merge", ids: [], problems: [] });
  });

  test("ci list text gives the reason a commit's work item is unknown", async () => {
    const doc = (await ciList({ cwd: root, now: NOW })) as Listed;
    const text = formatList(doc).split("\n");
    const line = (s: string) => text.find((l) => l.includes(s.slice(0, 12)))!;
    expect(line(sha.c3)).toContain("; why unknown: no Chant-Record or Chant-Lease trailer names a work item");
    expect(line(sha.c4)).toContain("; why unknown: the work item named is not there: Chant-Record: work:W-999");
    expect(line(sha.c1)).not.toContain("why unknown");
    expect(line(sha.m)).not.toContain("why unknown");
  });

  test("the field is null where the workspace declares no work kind", async () => {
    const plain = scratchDir("chant-links-plain-");
    git(plain, "init", "-q");
    git(plain, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFiles(plain, {
      "chant.workspace.json": JSON.stringify({ name: "plain", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "x" }], ci: { green: { branch: "main", phases: { lint: ["lint"] }, require: ["lint"] } } }),
      "app/a.txt": "a\n",
    });
    git(plain, "add", "-A");
    git(plain, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "one");
    const doc = (await ciList({ cwd: plain })) as Listed;
    list.expectValid(doc);
    expect(doc.commits.map((c) => c.work)).toEqual([null]);
    expect(formatList(doc)).not.toContain("why unknown");
  });

  test("ci tick shows an unlinked commit with why unknown", async () => {
    origin = scratchDir("chant-links-origin-");
    git(origin, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", origin);
    git(root, "push", "-q", "origin", "main");
    const forge: CiForge = { kind: "github", checkRuns: async () => [] };
    const result = await ciTick({ cwd: root, forge, now: NOW, dryRun: true });
    const text = formatTick(result, true);
    const line = (s: string) => text.split("\n").find((l) => l.includes(s.slice(0, 12)))!;
    expect(line(sha.c3)).toMatch(/undecided: lint; why unknown: no Chant-Record or Chant-Lease trailer names a work item/);
    expect(line(sha.c1)).not.toContain("why unknown");
  });

  test("whyWorkUnknown names nothing for a linked commit, a merge or no field", () => {
    expect(whyWorkUnknown(null)).toBeUndefined();
    expect(whyWorkUnknown(undefined)).toBeUndefined();
    expect(whyWorkUnknown({ state: "linked", ids: ["work:W-1"], problems: [] })).toBeUndefined();
    expect(whyWorkUnknown({ state: "merge", ids: [], problems: [] })).toBeUndefined();
  });
});
