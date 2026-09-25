/**
 * The two gaps a work item could not name before #2686, a stale pin and an
 * open dissent, and `work-done-gap-open` on a records read, on a workspace
 * built in a throwaway git repository:
 *
 * - c1 adds the app, the screen spec `design/screens/home.json`, and dec-001,
 *   which constrains the spec's path and pins it by hash.
 * - c2 adds dec-002, which supersedes dec-001, constrains the same path and
 *   pins the spec at the same hash, so its pin is stale; dec-003, which
 *   constrains `app/server.mjs` and has one open dissent (bob's), one
 *   withdrawn and one addressed; and the work items:
 *   W-001 (open, from intent-pin-stale on the spec), W-002 (open, from
 *   intent-decision-contested on the server), W-003 (done, from
 *   intent-decision-contested on the server, which still fires), W-004
 *   (done, from intent-pin-drifted on the spec, which does not fire) and
 *   W-005 (open, implements dec-002 and dec-003, no gap source).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sha256Hex } from "../content-digest";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { intentGraph, type FindingNode, type IntentDocument, type WorkNode } from "./intent";
import intentSchema from "./intent.schema.json";
import { parseFrontMatter } from "./records";
import { queryRecords } from "./records-cli";
import recordsSchema from "./records.schema.json";

const REF = join(REPO, "reference-workspace");
const BASE = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "decisions", "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

const HOME = `${JSON.stringify({ route: "/", regions: ["header"] }, null, 2)}\n`;
const pin = { title: "The home screen spec", path: "design/screens/home.json", sha256: sha256Hex(Buffer.from(HOME)), as_of: "2026-09-24T12:00:00Z" };

function decision(id: string, fields: Record<string, unknown>): string {
  const data = { ...BASE, id, title: `Decision ${id}`, state: "decided", supersedes: [], evidence: [], reviews: [], ...fields };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

function work(id: string, fields: Record<string, unknown>): string {
  const data = { schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: ["path:app/server.mjs"], evidence: [], opened_on: "2026-09-24", supersedes: [], ...fields };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n\nWhat the work is.\n`;
}

const done = { state: "done", closed_on: "2026-09-25", evidence: [{ title: "The review", url: "https://example.com/review" }] };
const KIND_FILES = {
  "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
  "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
  "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
  "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
};
const DECLARATION = JSON.stringify({
  name: "studio",
  schema: 1,
  members: [
    { name: "app", dir: "app", kind: "other", because: "a plain Node server" },
    { name: "design", dir: "design", kind: "other", because: "the screen specs" },
  ],
});

const DEC_003 = decision("dec-003", {
  constrains: ["path:app/server.mjs"],
  reviews: [
    { reviewer: "Bob", verdict: "dissent", note: "The port is wrong.", on: "2026-09-24" },
    { reviewer: "carol", verdict: "dissent", note: "Too early.", on: "2026-09-24", withdrawn_on: "2026-09-25" },
    { reviewer: "dave", verdict: "dissent", note: "Needs a test.", on: "2026-09-24", addressed_by: "acme/studio#7" },
    { reviewer: "erin", verdict: "agree", on: "2026-09-24" },
  ],
});

let root: string;

function commit(message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

beforeAll(() => {
  root = repo({
    "chant.workspace.json": DECLARATION,
    "app/server.mjs": "export const port = 8080;\n",
    "design/screens/home.json": HOME,
    ...KIND_FILES,
    "decisions/dec-001-spec.md": decision("dec-001", { constrains: ["path:design/screens/home.json"], evidence: [pin] }),
  });
  commit("the app, the spec and dec-001");
  writeFiles(root, {
    "decisions/dec-002-spec-again.md": decision("dec-002", { constrains: ["path:design/screens/home.json"], evidence: [pin], supersedes: [{ decision: "dec-001" }] }),
    "decisions/dec-003-server.md": DEC_003,
    "work/W-001-stale.md": work("W-001", { constrains: ["path:design/screens/home.json"], source: { finding: "intent-pin-stale", region: "design/screens/home.json", decision: "dec-002" } }),
    "work/W-002-contested.md": work("W-002", { source: { finding: "intent-decision-contested", region: "app/server.mjs", decision: "dec-003" } }),
    "work/W-003-contested-done.md": work("W-003", { ...done, source: { finding: "intent-decision-contested", region: "app/server.mjs", decision: "dec-003" } }),
    "work/W-004-drift-done.md": work("W-004", { ...done, constrains: ["path:design/screens/home.json"], source: { finding: "intent-pin-drifted", region: "design/screens/home.json" } }),
    "work/W-005-carry-out.md": work("W-005", { implements: ["dec-002", "dec-003"] }),
  });
  commit("dec-002 supersedes dec-001, dec-003 is contested, and the work");
});
afterAll(cleanScratch);

const intent = contract(intentSchema);
const records = contract(recordsSchema);
type Result = Exclude<IntentDocument, { error: unknown }>;

async function walk(region: string): Promise<Result> {
  const { doc } = await intentGraph({ cwd: root, region, kinds: ["decisions/decision.kind.mjs", "work/work.kind.mjs"].map((k) => join(root, k)) });
  intent.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const findingsOf = (doc: Result, code: string) => doc.nodes.filter((n): n is FindingNode => n.kind === "finding" && n.code === code);

describe("intent-pin-stale (#2686)", () => {
  test("a current decision pinning the artifact at the hash the record it supersedes pinned is stale, beside drifted and missing", async () => {
    const doc = await walk("design/screens/home.json");
    expect(doc.nodes.find((n) => n.id === "artifact:design/screens/home.json")).toMatchObject({ pinState: "stale" });
    const stale = findingsOf(doc, "intent-pin-stale");
    expect(stale).toHaveLength(1);
    expect(stale[0].concerns).toEqual(["record:decision/dec-002", "artifact:design/screens/home.json", "record:decision/dec-001"]);
    expect(stale[0].message).toContain("dec-001");
    expect(findingsOf(doc, "intent-pin-drifted")).toEqual([]);
    expect(findingsOf(doc, "intent-pin-missing")).toEqual([]);
  });

  test("it is addressed by the item that came from it and by the item implementing the decision", async () => {
    const doc = await walk("design/screens/home.json");
    const [stale] = findingsOf(doc, "intent-pin-stale");
    expect(stale).toMatchObject({ addressed: true, addressedBy: [{ id: "W-001", state: "open" }, { id: "W-005", state: "open" }] });
    expect(doc.edges).toContainEqual({ kind: "addressed-by", from: stale.id, to: "record:work/W-001" });
    expect(doc.edges).toContainEqual({ kind: "addressed-by", from: stale.id, to: "record:work/W-005" });
  });

  test("a stale pin on a decision in the graph only through supersession is not raised", async () => {
    // app/server.mjs brings in no decision pinning the spec.
    const doc = await walk("app/server.mjs");
    expect(findingsOf(doc, "intent-pin-stale")).toEqual([]);
  });
});

describe("intent-decision-contested (#2686)", () => {
  test("a current decision constraining the region with a dissent neither addressed nor withdrawn is contested, with the count and principals", async () => {
    const doc = await walk("app/server.mjs");
    const contested = findingsOf(doc, "intent-decision-contested");
    expect(contested).toHaveLength(1);
    expect(contested[0]).toMatchObject({ concerns: ["record:decision/dec-003", "region:app/server.mjs"], openConcerns: { count: 1, principals: ["bob"] } });
    expect(contested[0].message).toContain("1 open concern, from Bob");
  });

  test("it is addressed by the items that came from it, and not through implements", async () => {
    const doc = await walk("app/server.mjs");
    const [contested] = findingsOf(doc, "intent-decision-contested");
    expect(contested.addressedBy).toEqual([
      { id: "W-002", state: "open" },
      { id: "W-003", state: "done" },
    ]);
    expect(doc.edges).toContainEqual({ kind: "addressed-by", from: contested.id, to: "record:work/W-002" });
    const w003 = doc.nodes.find((n): n is WorkNode => n.kind === "work" && n.record === "W-003");
    expect(w003!.warnings.map((w) => w.code)).toEqual(["work-done-gap-open"]);
  });

  test("a decision whose dissents are all addressed or withdrawn is not contested", async () => {
    writeFiles(root, { "decisions/dec-003-server.md": DEC_003.replace(`"note": "The port is wrong.",`, `"note": "The port is wrong.", "addressed_by": "acme/studio#8",`) });
    try {
      const doc = await walk("app/server.mjs");
      expect(findingsOf(doc, "intent-decision-contested")).toEqual([]);
    } finally {
      writeFiles(root, { "decisions/dec-003-server.md": DEC_003 });
    }
  });
});

describe("work-done-gap-open in records (#2686)", () => {
  test("records --json warns on a done item whose gap still fires, and not on one whose gap closed", async () => {
    const doc = await queryRecords({ kind: "work/work.kind.mjs", cwd: root });
    records.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const warned = Object.fromEntries(doc.records.map((r) => [r.id, r.warnings.map((w) => w.code)]));
    expect(warned).toEqual({ "W-001": [], "W-002": [], "W-003": ["work-done-gap-open"], "W-004": [], "W-005": [] });
    expect(doc.records.find((r) => r.id === "W-003")!.warnings[0].message).toContain("intent-decision-contested");
  });

  test("the warning follows the revision read: under --at c1 there is no work, and under --at HEAD W-003 is warned", async () => {
    const c1 = git(root, "rev-parse", "HEAD~1");
    const doc = await queryRecords({ kind: "work/work.kind.mjs", cwd: root, at: c1 });
    records.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.records).toEqual([]);
    const head = await queryRecords({ kind: "work/work.kind.mjs", cwd: root, at: "HEAD" });
    if ("error" in head) throw new Error(head.error.message);
    expect(head.records.find((r) => r.id === "W-003")!.warnings.map((w) => w.code)).toEqual(["work-done-gap-open"]);
  });

  test("without a workspace declaration the walk can't be made, so the record is left as it was", async () => {
    const bare = repo({
      "app/server.mjs": "export const port = 8080;\n",
      ...KIND_FILES,
      "decisions/dec-003-server.md": DEC_003,
      "work/W-003-contested-done.md": work("W-003", { ...done, source: { finding: "intent-decision-contested", region: "app/server.mjs" } }),
    });
    git(bare, "add", "-A");
    git(bare, "commit", "-q", "-m", "one");
    const doc = await queryRecords({ kind: "work/work.kind.mjs", cwd: bare });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.records[0].warnings).toEqual([]);
  });

  test("the intent graph reads its kinds without asking records for the warning, so it is raised once", async () => {
    const doc = await walk("app/server.mjs");
    const w003 = doc.nodes.find((n): n is WorkNode => n.kind === "work" && n.record === "W-003");
    expect(w003!.warnings.filter((w) => w.code === "work-done-gap-open")).toHaveLength(1);
  });
});
