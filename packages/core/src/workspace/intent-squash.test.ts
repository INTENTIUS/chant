/**
 * Following a squash merge to the pull request's original commits (#3035).
 *
 * - `forge` is a bare repository standing in for the forge: origin, with the
 *   pull request heads at refs/pull/<n>/head.
 * - Pull request 7 has two commits: o1 changes line 2 of app/server.ts with
 *   `Chant-Run: run-a` and `Chant-Record: work:W-001`, and o2 changes line 4
 *   and is listed by run B's end. main squashes them into sq, "feature (#7)".
 * - s-001 (path:app/server.ts) is decided; W-001 implements it.
 * - "other (#8)" changes app/other.ts, and the forge has no ref for 8.
 * - "fix (#9)" is committed on main itself, and refs/pull/9/head is that
 *   commit, as after a rebase merge: nothing to follow.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { intentGraph, type CommitNode, type IntentDocument } from "./intent";
import { formatIntent } from "./intent-cli";
import { intentRecord } from "./intent-record";
import intentRecordSchema from "./intent-record.schema.json";
import intentSchema from "./intent.schema.json";
import { parseFrontMatter } from "./records";
import { runsWrite, workspaceRuns } from "./runs-cli";
import runsSchema from "./runs.schema.json";
import { forgeOf, pullRequestOf } from "./squash";
import { readArgv } from "../cli/mcp/workspace-tools";

const REF = join(REPO, "reference-workspace");
const BASE = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "decisions", "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();
const decision = (id: string, fields: Record<string, unknown>) => `---\n${JSON.stringify({ ...BASE, id, title: `Decision ${id}`, state: "decided", supersedes: [], evidence: [], reviews: [], ...fields }, null, 2)}\n---\n\n# ${id}\n`;
const work = (id: string, fields: Record<string, unknown>) =>
  `---\n${JSON.stringify({ schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: [], evidence: [], opened_on: "2026-10-01", supersedes: [], ...fields }, null, 2)}\n---\n\n# ${id}\n\nWhat the work is.\n`;

const LINES = ["// The app server.", "export const a = 0;", "export const b = 0;", "export const c = 0;", "export const d = 0;"];
const text = (lines: string[]) => `${lines.join("\n")}\n`;
const edit = (lines: string[], at: number, to: string) => lines.map((l, i) => (i === at - 1 ? to : l));

type Doc = Exclude<IntentDocument, { error: unknown }>;

let root: string;
let forge: string;
const sha: Record<string, string> = {};

function commit(message: string[]): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", ...message.flatMap((m) => ["-m", m]));
  return git(root, "rev-parse", "HEAD");
}
async function record(fields: object): Promise<void> {
  const doc = await runsWrite({ verb: "record", fields: JSON.stringify(fields), cwd: root });
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
}
async function walk(region: string, followSquash: boolean): Promise<Doc> {
  const { doc } = await intentGraph({ cwd: root, region, followSquash });
  contract(intentSchema).expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}
const commitNode = (doc: Doc, s: string) => doc.nodes.find((n): n is CommitNode => n.kind === "commit" && n.sha === s);

beforeAll(async () => {
  root = repo({
    "chant.workspace.json": JSON.stringify({ name: "squash", schema: 1, records: [{ kind: "decisions/decision.kind.mjs" }, { kind: "work/work.kind.mjs" }], members: [{ name: "app", dir: "app", kind: "other", because: "the app" }] }),
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "app/server.ts": text(LINES),
    "app/other.ts": "export const other = 0;\n",
    "app/fix.ts": "export const fix = 0;\n",
    "decisions/s-001-server.md": decision("s-001", { constrains: ["path:app/server.ts"] }),
    "work/W-001-server.md": work("W-001", { implements: ["s-001"] }),
  });
  sha.c0 = commit(["the workspace"]);
  const main = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  forge = scratchDir("chant-forge-");
  git(forge, "init", "-q", "--bare");
  git(root, "remote", "add", "origin", forge);

  // Pull request 7, pushed to the forge's pull ref, and its branch gone from the clone.
  git(root, "checkout", "-q", "-b", "feature");
  writeFiles(root, { "app/server.ts": text(edit(LINES, 2, "export const a = 1;")) });
  sha.o1 = commit(["a is 1", "Chant-Run: run-a\nChant-Record: work:W-001"]);
  writeFiles(root, { "app/server.ts": text(edit(edit(LINES, 2, "export const a = 1;"), 4, "export const c = 1;")) });
  sha.o2 = commit(["c is 1"]);
  git(root, "push", "-q", "origin", "feature:refs/pull/7/head");
  git(root, "checkout", "-q", main);
  git(root, "branch", "-q", "-D", "feature");

  await record({ id: "run-a", harness: "claude-code", model: "claude-opus-5-5", unit: "W-001", startedAt: "2026-10-01T10:00:00Z" });
  await record({ id: "run-b", harness: "claude-code", model: "claude-sonnet", startedAt: "2026-10-01T11:00:00Z", commits: [sha.o2] });

  git(root, "merge", "--squash", "-q", sha.o2);
  sha.sq = commit(["feature (#7)"]);
  writeFiles(root, { "app/other.ts": "export const other = 1;\n" });
  sha.other = commit(["other (#8)"]);
  writeFiles(root, { "app/fix.ts": "export const fix = 1;\n" });
  sha.fix = commit(["fix (#9)"]);
  git(root, "push", "-q", "origin", `${sha.fix}:refs/pull/9/head`);
}, 60_000);
afterAll(cleanScratch);

describe("squash commits", () => {
  test("the forge comes from the remote, and the pull request from the subject", () => {
    expect(forgeOf("https://github.com/INTENTIUS/chant.git")).toBe("github");
    expect(forgeOf("git@github.com:INTENTIUS/chant.git")).toBe("github");
    expect(forgeOf("https://github.acme.example/team/repo")).toBe("github");
    expect(forgeOf("https://codeberg.org/forgejo/forgejo.git")).toBe("forgejo");
    expect(forgeOf("ssh://git@forgejo.example.org:2222/team/repo.git")).toBe("forgejo");
    expect(forgeOf("https://gitea.example.org/team/repo")).toBe("forgejo");
    expect(forgeOf("/srv/git/repo.git")).toBeNull();
    expect(forgeOf(null)).toBeNull();
    expect(pullRequestOf("feature (#7)")).toBe(7);
    expect(pullRequestOf("feature (#7) and more")).toBeNull();
    // The MCP tools pass the option on, and leave it off by default.
    expect(readArgv("workspace-graph", { intent: "app/server.ts", followSquash: true })).toEqual(["workspace", "graph", "--intent", "app/server.ts", "--follow-squash", "--json"]);
    expect(readArgv("workspace-graph", { intent: "app/server.ts" })).toEqual(["workspace", "graph", "--intent", "app/server.ts", "--json"]);
    expect(readArgv("workspace-runs", { followSquash: true })).toEqual(["workspace", "runs", "--follow-squash", "--json"]);
  });

  test("without --follow-squash the walk reads nothing from the forge", async () => {
    const doc = await walk("app/server.ts", false);
    const sq = commitNode(doc, sha.sq)!;
    expect(sq.pullRequest).toBe(7);
    expect(sq.squash).toBeUndefined();
    expect(doc.edges.filter((e) => e.kind === "made-by" && e.from === sq.id)).toEqual([]);
    expect(git(root, "for-each-ref", "refs/chant/pull/")).toBe("");
  });

  test("--follow-squash fetches the pull request's head and reports the original commits under the squash", async () => {
    const doc = await walk("app/server.ts", true);
    const sq = commitNode(doc, sha.sq)!;
    expect(sq.squash).toMatchObject({ pullRequest: 7, forge: null, ref: "refs/chant/pull/7/head", head: sha.o2, fetched: true, followed: true });
    expect(sq.squash!.commits.map((o) => [o.sha, o.subject, o.joins.run, o.joins.records.map((r) => `${r.kind}:${r.id}`)])).toEqual([
      [sha.o1, "a is 1", "run-a", ["work:W-001"]],
      [sha.o2, "c is 1", null, []],
    ]);
    expect(sq.squash!.commits[0].signature.level).toBe("unattested");
    // The squash joins both runs, through the commit each made.
    expect(doc.edges.filter((e) => e.kind === "made-by" && e.from === sq.id)).toEqual([
      { kind: "made-by", from: sq.id, to: "run:run-a", joinedBy: ["squash"], via: [sha.o1] },
      { kind: "made-by", from: sq.id, to: "run:run-b", joinedBy: ["squash"], via: [sha.o2] },
    ]);
    // o1's Chant-Record is carried by the squash, so it is s-001's own work.
    expect(doc.edges).toContainEqual({ kind: "carries", from: sq.id, to: "record:work/W-001" });
    expect(doc.edges).toContainEqual({ kind: "within", from: sq.id, to: "record:decision/s-001", state: "decided" });
    // Blame at the head says which original wrote each line, so each line has the one run that wrote it.
    expect(doc.why.blame.filter((s) => s.sha === sha.sq)).toEqual([
      { start: 2, end: 2, commit: sq.id, sha: sha.sq, runs: ["run:run-a"], narrowedBy: null, joinedBy: ["squash"], via: [sha.o1] },
      { start: 4, end: 4, commit: sq.id, sha: sha.sq, runs: ["run:run-b"], narrowedBy: null, joinedBy: ["squash"], via: [sha.o2] },
    ]);
    expect(doc.why.runs.map((r) => [r.run, r.lines, r.joinedBy])).toEqual([
      ["run:run-b", 1, ["squash"]],
      ["run:run-a", 1, ["squash"]],
    ]);
    expect(doc.why.gaps.map((g) => g.code)).not.toContain("intent-why-run-ambiguous");
    const out = formatIntent(doc);
    expect(out).toContain("squash    #7: 2 original commits from refs/chant/pull/7/head, fetched");
    expect(out).toContain(`(squashed from ${sha.o1.slice(0, 8)})`);

    // The next read finds the ref in the clone and fetches nothing.
    const again = await walk("app/server.ts", true);
    expect(commitNode(again, sha.sq)!.squash).toMatchObject({ ref: "refs/chant/pull/7/head", fetched: false, followed: true });
  });

  test("a ref the forge doesn't have is reported, never fatal, and a rebased pull request is not a squash", async () => {
    const other = await walk("app/other.ts", true);
    expect(commitNode(other, sha.other)!.squash).toEqual({ pullRequest: 8, forge: null, ref: null, head: null, fetched: false, followed: false, commits: [] });
    expect(other.reasons).toEqual([expect.objectContaining({ code: "squash-unfollowed", message: expect.stringContaining("refs/pull/8/head could not be fetched from origin") })]);
    const fix = await walk("app/fix.ts", true);
    expect(commitNode(fix, sha.fix)!.squash).toBeUndefined();
    expect(fix.reasons).toEqual([]);
  });

  test("graph --intent --record counts the squash under the work its original commits carried", async () => {
    const { doc } = await intentRecord({ cwd: root, record: "s-001", followSquash: true });
    contract(intentRecordSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const sq = doc.commits.find((c) => c.sha === sha.sq)!;
    expect(sq.bucket).toBe("own");
    expect(sq.squash).toMatchObject({ pullRequest: 7, followed: true, commits: [{ sha: sha.o1 }, { sha: sha.o2 }] });
    expect(sq.runs.map((r) => [r.id, r.joinedBy, r.via])).toEqual([
      ["run-a", ["squash"], [sha.o1]],
      ["run-b", ["squash"], [sha.o2]],
    ]);
    const plain = await intentRecord({ cwd: root, record: "s-001" });
    if ("error" in plain.doc) throw new Error(plain.doc.error.message);
    expect(plain.doc.commits.find((c) => c.sha === sha.sq)).toMatchObject({ bucket: "worked", runs: [] });
  });

  test("runs --json --follow-squash adds the squash to each run its original commits joined", async () => {
    const doc = await workspaceRuns({ cwd: root, followSquash: true });
    contract(runsSchema).expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.filter.followSquash).toBe(true);
    const byId = new Map(doc.runs.map((r) => [r.id, r]));
    expect(byId.get("run-a")!.commits).toEqual([{ sha: sha.sq, patchId: expect.any(String), joinedBy: ["squash"], hunks: null, via: [sha.o1] }]);
    expect(byId.get("run-b")!.commits.map((c) => [c.sha, c.joinedBy, c.via])).toEqual([
      [sha.o2, ["record"], undefined],
      [sha.sq, ["squash"], [sha.o2]],
    ]);
    expect(doc.reasons.map((r) => r.code)).toEqual(["squash-unfollowed"]);
    const plain = await workspaceRuns({ cwd: root });
    if ("error" in plain) throw new Error(plain.error.message);
    expect(plain.runs.find((r) => r.id === "run-a")!.commits).toEqual([]);
  });
});
