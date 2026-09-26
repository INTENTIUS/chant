/**
 * Work items (#2683): the work kind on read, and its place in the intent
 * graph, on a workspace built in a throwaway git repository.
 *
 * - c0 adds `app/server.mjs` and `app/other.mjs` before any decision, so
 *   commits to them are undecided.
 * - c1 adds the decision and work kinds, dec-001 (decided, constrains
 *   `path:app/server.mjs`), dec-002 (decided, constrains `path:app/other.mjs`,
 *   implemented by nothing), dec-003 (proposed), W-001 (in progress,
 *   implements dec-001, from the gap intent-decision-unimplemented on
 *   `app/server.mjs`), W-002 (open, needs W-001) and W-003 (done, from the
 *   gap intent-commit-undecided on `app/server.mjs`) and W-004 (dropped,
 *   implements dec-002).
 * - c2 edits `app/server.mjs` from unit U-0001, whose record names dec-001:
 *   dec-001's own work, inside W-001's and W-002's windows.
 * - c3 marks W-001 done, which closes its window after c3.
 * - c4 edits `app/server.mjs` again: inside W-002's window, outside W-001's.
 *
 * W-003 was added done, so its window is c1 alone and no edit falls in it.
 */

import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo, writeFiles } from "./__fixtures__/contract-repo";
import { formatIntent } from "./intent-cli";
import { intentGraph, INTENT_FINDING_CODES, type IntentDocument, type WorkNode } from "./intent";
import intentSchema from "./intent.schema.json";
import { parseFrontMatter } from "./records";
import { queryRecords } from "./records-cli";
import { amendRecord, newRecord, resolveWriteKind, reviewRecord } from "./records-write";
import recordsSchema from "./records.schema.json";
import { WORK_WARNING_CODES } from "./work";
import { CHANGES_FINDING_CODES } from "./changes";

const REF = join(REPO, "reference-workspace");
const DECISION = (() => {
  const fm = parseFrontMatter(readFileSync(join(REF, "decisions", "ref-001-how-the-app-is-deployed.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

function decision(id: string, fields: { state?: string; constrains: string[] }): string {
  const proposed = fields.state === "proposed";
  const data = { ...DECISION, id, title: `Decision ${id}`, state: fields.state ?? "decided", supersedes: [], evidence: [], constrains: fields.constrains, ...(proposed ? { choice: null, decided_by: null, decided_on: null } : {}) };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

function work(id: string, fields: Record<string, unknown>): string {
  const data = { schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: ["path:app/server.mjs"], evidence: [], opened_on: "2026-09-24", source: { kind: "workspace", member: "app" }, supersedes: [], ...fields };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n\nWhat the work is.\n`;
}

const PLUGIN = `
export function commitJoins(commit, context) {
  const id = commit.trailers["Unit"]?.[0];
  if (!id) return undefined;
  const unit = JSON.parse(context.read(\`units/\${id}.json\`));
  return { unit: { id, decisions: unit.decisions }, contract: { id: unit.contract } };
}
`;

const DECISIONS = "decisions/decision.kind.mjs";
const WORK = "work/work.kind.mjs";
const JOINS = "plugins/units.kind.mjs";

let root: string;
const sha: Record<string, string> = {};

function commit(message: string[]): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", ...message.flatMap((m) => ["-m", m]));
  return git(root, "rev-parse", "HEAD");
}

beforeAll(() => {
  root = repo({
    "chant.workspace.json": JSON.stringify({ name: "studio", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "a plain Node server" }] }, null, 2),
    "app/server.mjs": "export const port = 8080;\n",
    "app/other.mjs": "export const other = 1;\n",
  });
  sha.c0 = commit(["the app, before any decision"]);
  writeFiles(root, {
    "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "decisions/dec-001-server.md": decision("dec-001", { constrains: ["path:app/server.mjs"] }),
    "decisions/dec-002-other.md": decision("dec-002", { constrains: ["path:app/other.mjs"] }),
    "decisions/dec-003-maybe.md": decision("dec-003", { state: "proposed", constrains: ["member:app"] }),
    "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "work/W-001-server.md": work("W-001", {
      state: "in-progress",
      owner: "alice",
      implements: ["dec-001"],
      source: { finding: "intent-decision-unimplemented", region: "app/server.mjs", decision: "dec-001" },
    }),
    "work/W-002-after.md": work("W-002", { needs: ["W-001"] }),
    "work/W-003-undecided.md": work("W-003", {
      state: "done",
      closed_on: "2026-09-24",
      evidence: [{ title: "The review", url: "https://example.com/review" }],
      source: { finding: "intent-commit-undecided", region: "app/server.mjs" },
    }),
    "work/W-004-dropped.md": work("W-004", { state: "dropped", closed_on: "2026-09-24", implements: ["dec-002"], constrains: ["path:app/other.mjs"] }),
    "plugins/units.kind.mjs": PLUGIN,
    "units/U-0001.json": JSON.stringify({ contract: "C-001", decisions: ["dec-001"] }),
  });
  sha.c1 = commit(["decide and queue the work"]);
  writeFiles(root, { "app/server.mjs": "export const port = 9090;\n" });
  sha.c2 = commit(["move the port", "Unit: U-0001"]);
  writeFiles(root, {
    "work/W-001-server.md": work("W-001", {
      state: "done",
      owner: "alice",
      implements: ["dec-001"],
      closed_on: "2026-09-25",
      source: { finding: "intent-decision-unimplemented", region: "app/server.mjs", decision: "dec-001" },
    }),
  });
  sha.c3 = commit(["W-001 is done"]);
  writeFiles(root, { "app/server.mjs": "export const port = 9191;\n" });
  sha.c4 = commit(["move the port again"]);
});
afterAll(cleanScratch);

const records = contract(recordsSchema);
const intent = contract(intentSchema);
type Result = Exclude<IntentDocument, { error: unknown }>;

async function walk(region: string, options: { kinds?: string[]; at?: string } = {}): Promise<Result> {
  const { doc } = await intentGraph({ cwd: root, region, at: options.at, kinds: (options.kinds ?? [DECISIONS, WORK, JOINS]).map((k) => join(root, k)) });
  intent.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const workNode = (doc: Result, id: string) => doc.nodes.find((n): n is WorkNode => n.kind === "work" && n.record === id);
const codes = (doc: Result) => doc.nodes.flatMap((n) => (n.kind === "finding" ? [n.code] : []));

describe("work records on read (#2683)", () => {
  test("ready, blockedBy and implements on each record, and implementedBy on each decision", async () => {
    const doc = await queryRecords({ kind: WORK, cwd: root, at: sha.c2 });
    records.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.summary).toEqual({ total: 4, valid: 4, invalid: 0, superseded: 0 });
    const by = Object.fromEntries(doc.records.map((r) => [r.id, r]));
    expect(by["W-001"]).toMatchObject({ ready: false, blockedBy: [], implements: [{ id: "dec-001", state: "decided" }], warnings: [] });
    expect(by["W-002"]).toMatchObject({ ready: false, blockedBy: [{ id: "W-001", state: "in-progress" }], implements: [], warnings: [] });
    // W-003 is done, and intent-commit-undecided, its gap, still fires on app/server.mjs: c0 changed it before any decision (#2686).
    expect(by["W-003"]).toMatchObject({ ready: false, blockedBy: [] });
    expect(by["W-003"].warnings.map((w: { code: string }) => w.code)).toEqual(["work-done-gap-open"]);
    expect(doc.decisions).toEqual([
      { id: "dec-001", path: "decisions/dec-001-server.md", state: "decided", supersededBy: null, implementedBy: [{ id: "W-001", state: "in-progress" }] },
      { id: "dec-002", path: "decisions/dec-002-other.md", state: "decided", supersededBy: null, implementedBy: [{ id: "W-004", state: "dropped" }] },
      { id: "dec-003", path: "decisions/dec-003-maybe.md", state: "proposed", supersededBy: null, implementedBy: [] },
    ]);
  });

  test("an item is ready once every need is done", async () => {
    const doc = await queryRecords({ kind: WORK, cwd: root });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.records.find((r) => r.id === "W-002")).toMatchObject({ ready: true, blockedBy: [] });
    // W-001 is done with an empty evidence list.
    expect(doc.records.find((r) => r.id === "W-001")!.warnings.map((w) => w.code)).toEqual(["work-done-unpinned"]);
  });

  test("each work warning, and no record-no-evidence on an open item", async () => {
    const dir = repo({
      "chant.workspace.json": JSON.stringify({ name: "w", schema: 1, members: [] }),
      "decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
      "decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
      "decisions/dec-003-maybe.md": decision("dec-003", { state: "proposed", constrains: ["member:app"] }),
      "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
      "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
      "work/W-010-a.md": work("W-010", { needs: ["W-011", "W-099"], implements: ["dec-003", "dec-404"] }),
      "work/W-011-b.md": work("W-011", { needs: ["W-010"] }),
      "work/W-012-c.md": work("W-012", { state: "done" }),
      "work/W-013-d.md": work("W-013", { state: "dropped", closed_on: "2026-09-24" }),
      "work/W-014-e.md": work("W-014", {}),
    });
    const doc = await queryRecords({ kind: WORK, cwd: dir });
    records.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const warned = Object.fromEntries(doc.records.map((r) => [r.id, r.warnings.map((w) => w.code)]));
    expect(warned).toEqual({
      "W-010": ["work-needs-unknown", "work-implements-unknown", "work-needs-cycle", "work-implements-undecided"],
      "W-011": ["work-needs-cycle"],
      "W-012": ["work-done-unpinned", "work-closed-without-date"],
      "W-013": [],
      "W-014": [],
    });
    const w010 = doc.records.find((r) => r.id === "W-010")!;
    expect(w010.blockedBy).toEqual([
      { id: "W-011", state: "open" },
      { id: "W-099", state: null },
    ]);
    expect(w010.implements).toEqual([
      { id: "dec-003", state: "proposed" },
      { id: "dec-404", state: null },
    ]);
    expect(doc.records.find((r) => r.id === "W-014")!.ready).toBe(true);
  });

  test("the work warnings are the reason codes the schemas carry", () => {
    const text = JSON.stringify(recordsSchema) + JSON.stringify(intentSchema);
    for (const c of WORK_WARNING_CODES) expect(text, c).toContain(`"${c}"`);
  });

  test("a work kind whose decision kind is missing fails the read with kind-unreadable", async () => {
    const dir = repo({
      "work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
      "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    });
    const doc = await queryRecords({ kind: WORK, cwd: dir });
    records.expectValid(doc);
    expect("error" in doc && doc.error.code).toBe("kind-unreadable");
  });

  test("a work kind without states is kind-invalid", async () => {
    const kindText = readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8")
      .replace(/^  stateField: "state",\n/m, "")
      .replace(/^  states: \[.*\],\n/m, "")
      .replace(/^  closedStates: \[.*\],\n/m, "")
      .replace(/^  supersedes: .*\n/m, "");
    const dir = repo({ "work/work.kind.mjs": kindText, "work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8") });
    const doc = await queryRecords({ kind: WORK, cwd: dir });
    expect("error" in doc && doc.error.code).toBe("kind-invalid");
  });

  test("the reference work schema's finding codes are the intent graph's and the change check's (#2773)", () => {
    const schema = JSON.parse(readFileSync(join(REF, "work", "work.schema.json"), "utf-8")) as { definitions: { sourceGap: { properties: { finding: { anyOf: [{ enum: string[] }] } } } } };
    expect(schema.definitions.sourceGap.properties.finding.anyOf[0].enum).toEqual([...INTENT_FINDING_CODES, ...CHANGES_FINDING_CODES]);
  });
});

describe("work items in the intent graph (#2683)", () => {
  test("at c2: work nodes, implements and needs edges, worked commits, and both work findings", async () => {
    const doc = await walk("app/server.mjs", { at: sha.c2 });
    expect(workNode(doc, "W-001")).toMatchObject({
      id: "record:work/W-001",
      recordKind: "work",
      state: "in-progress",
      closed: false,
      owner: "alice",
      ready: false,
      blockedBy: [],
      implements: [{ id: "dec-001", state: "decided" }],
      source: { finding: "intent-decision-unimplemented", region: "app/server.mjs", decision: "dec-001" },
      constrains: [{ entry: "path:app/server.mjs", granularity: "path" }],
      warnings: [],
    });
    expect(workNode(doc, "W-002")).toMatchObject({ state: "open", ready: false, blockedBy: [{ id: "W-001", state: "in-progress" }], needs: ["W-001"] });
    expect(doc.edges).toContainEqual({ kind: "implements", from: "record:work/W-001", to: "record:decision/dec-001" });
    expect(doc.edges).toContainEqual({ kind: "needs", from: "record:work/W-002", to: "record:work/W-001" });
    const within = doc.edges.filter((e) => e.kind === "within").map((e) => [e.from, e.to, "state" in e ? e.state : null]);
    expect(within).toEqual([
      [`commit:${sha.c2}`, "record:decision/dec-001", "decided"],
      [`commit:${sha.c2}`, "record:work/W-001", "worked"],
      [`commit:${sha.c2}`, "record:work/W-002", "worked"],
    ]);
    // A worked edge leaves the commit's own state to the decisions.
    expect(doc.nodes.find((n) => n.id === `commit:${sha.c2}`)).toMatchObject({ state: "decided" });
    expect(codes(doc)).toContain("intent-work-blocked");
    expect(codes(doc)).toContain("intent-work-open-decided-code");
    expect(codes(doc)).not.toContain("intent-decision-unimplemented");
    const blocked = doc.nodes.find((n) => n.kind === "finding" && n.code === "intent-work-blocked");
    expect(blocked).toMatchObject({ concerns: ["record:work/W-002", `commit:${sha.c2}`, "record:work/W-001"] });
    const open = doc.nodes.find((n) => n.kind === "finding" && n.code === "intent-work-open-decided-code");
    expect(open).toMatchObject({ concerns: ["record:decision/dec-001", `commit:${sha.c2}`, "record:work/W-001"] });
  });

  test("at HEAD: W-001's window closed with c3, so c4 is worked by W-002 alone, and neither work finding fires", async () => {
    const doc = await walk("app/server.mjs");
    const worked = doc.edges.filter((e) => e.kind === "within" && "state" in e && e.state === "worked").map((e) => [e.from, e.to]);
    expect(worked).toEqual([
      [`commit:${sha.c4}`, "record:work/W-002"],
      [`commit:${sha.c2}`, "record:work/W-001"],
      [`commit:${sha.c2}`, "record:work/W-002"],
    ]);
    expect(workNode(doc, "W-001")).toMatchObject({ state: "done", closed: true, warnings: [{ code: "work-done-unpinned" }] });
    expect(workNode(doc, "W-002")).toMatchObject({ ready: true, blockedBy: [] });
    expect(codes(doc)).not.toContain("intent-work-blocked");
    expect(codes(doc)).not.toContain("intent-work-open-decided-code");
  });

  test("a finding a work item came from is addressed by it, and a done item whose gap still fires gets work-done-gap-open", async () => {
    const doc = await walk("app/server.mjs");
    const undecided = doc.nodes.filter((n) => n.kind === "finding" && n.code === "intent-commit-undecided");
    // c0 changed the file before any decision.
    expect(undecided.length).toBe(1);
    expect(undecided[0]).toMatchObject({ addressed: true, addressedBy: [{ id: "W-003", state: "done" }] });
    expect(doc.edges).toContainEqual({ kind: "addressed-by", from: undecided[0].id, to: "record:work/W-003" });
    expect(workNode(doc, "W-003")!.warnings.map((w) => w.code)).toEqual(["work-done-gap-open"]);
    // Every finding says whether a work item addresses it once a work kind is read.
    for (const f of doc.nodes.filter((n) => n.kind === "finding")) expect(f).toHaveProperty("addressed");
  });

  test("a decided decision only a dropped item implements, and no commit carried out, is intent-decision-unimplemented, and nothing addresses it", async () => {
    const doc = await walk("app/other.mjs");
    expect(doc.edges).toContainEqual({ kind: "implements", from: "record:work/W-004", to: "record:decision/dec-002" });
    const f = doc.nodes.find((n) => n.kind === "finding" && n.code === "intent-decision-unimplemented");
    expect(f).toMatchObject({ concerns: ["record:decision/dec-002", "region:app/other.mjs"], addressed: false, addressedBy: [] });
  });

  test("without a work kind the walk is what it was: no work node, no work finding, no addressed field", async () => {
    const doc = await walk("app/other.mjs", { kinds: [DECISIONS, JOINS] });
    expect(doc.nodes.some((n) => n.kind === "work")).toBe(false);
    expect(codes(doc)).not.toContain("intent-decision-unimplemented");
    for (const f of doc.nodes.filter((n) => n.kind === "finding")) expect(f).not.toHaveProperty("addressed");
  });

  test("the walk prints each work item with its worked commits and warnings", async () => {
    const text = formatIntent(await walk("app/server.mjs"));
    expect(text).toContain("work      W-001 done, owned by alice: Work W-001; constrains path:app/server.mjs (path); implements dec-001 (decided); from intent-decision-unimplemented on app/server.mjs");
    expect(text).toContain(`  worked    ${sha.c4.slice(0, 8)} move the port again; in W-002's window`);
    expect(text).toContain("  warning   work-done-gap-open:");
    expect(text).toMatch(/finding {3}intent-commit-undecided: .*; addressed by W-003 \(done\)/);
    expect(text).toMatch(/3 work items/);
  });
});

describe("writing work items on a copy of the reference workspace (#2683)", () => {
  let copy: string;
  beforeAll(() => {
    copy = realpathSync(mkdtempSync(join(tmpdir(), "chant-2683-write-")));
    for (const d of ["decisions", "work", "design"]) cpSync(join(REF, d), join(copy, d), { recursive: true });
    cpSync(join(REF, "chant.workspace.json"), join(copy, "chant.workspace.json"));
  });
  afterAll(() => rmSync(copy, { recursive: true, force: true }));

  const fresh = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 1,
      title: "Draw the status region in the wireframe",
      state: "open",
      implements: ["ref-002"],
      needs: ["W-001"],
      constrains: ["path:design/screens/home.svg"],
      evidence: [],
      opened_on: "2026-09-25",
      source: { finding: "intent-pin-drifted", region: "design/screens/home.json", decision: "ref-002" },
      supersedes: [],
      ...over,
    });

  test("records new work names the declared work kind", () => {
    expect(resolveWriteKind("work", copy)).toBe(join(copy, "work", "work.kind.mjs"));
    expect(resolveWriteKind("work/work.kind.mjs", copy)).toBe("work/work.kind.mjs");
    expect(resolveWriteKind("nothing", copy)).toBe("nothing");
  });

  test("records new allocates W-003 after W-001 and W-002, with a gap source that validates", async () => {
    const doc = await newRecord({ kind: resolveWriteKind("work", copy), fields: fresh(), cwd: copy });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    expect(doc).toMatchObject({ id: "W-003", path: "work/W-003-draw-the-status-region-in-the-wireframe.md" });
    const read = await queryRecords({ kind: "work/work.kind.mjs", cwd: copy });
    records.expectValid(read);
    if ("error" in read) throw new Error(read.error.message);
    expect(read.records.find((r) => r.id === "W-003")).toMatchObject({
      valid: true,
      ready: false,
      blockedBy: [{ id: "W-001", state: "in-progress" }],
      data: { source: { finding: "intent-pin-drifted", region: "design/screens/home.json", decision: "ref-002" } },
    });
  });

  test("records new refuses a gap source whose finding is not an intent finding code", async () => {
    const doc = await newRecord({ kind: "work/work.kind.mjs", fields: fresh({ source: { finding: "not-a-finding", region: "design" } }), dryRun: true, cwd: copy });
    expect("error" in doc && doc.error.code).toBe("record-schema-invalid");
  });

  test("records new refuses an ask source with no said or by (#2851)", async () => {
    const noSaid = await newRecord({ kind: "work/work.kind.mjs", fields: fresh({ source: { ask: { by: "morgan", at: "2026-09-25T10:00:00Z", via: "hud" } } }), dryRun: true, cwd: copy });
    expect("error" in noSaid && noSaid.error.code).toBe("record-schema-invalid");
    const noBy = await newRecord({ kind: "work/work.kind.mjs", fields: fresh({ source: { ask: { said: "Can we add a dark mode toggle?", at: "2026-09-25T10:00:00Z", via: "hud" } } }), dryRun: true, cwd: copy });
    expect("error" in noBy && noBy.error.code).toBe("record-schema-invalid");
  });

  test("records new with a fresh prefix takes --prefix W", async () => {
    const doc = await newRecord({ kind: "work/work.kind.mjs", fields: fresh(), prefix: "W", dryRun: true, cwd: copy });
    expect(doc).toMatchObject({ id: "W-004" });
  });

  test("records amend moves W-003 to in-progress with an owner", async () => {
    const doc = await amendRecord({ kind: "work/work.kind.mjs", id: "W-003", fields: JSON.stringify({ state: "in-progress", owner: "agent-1" }), cwd: copy });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    expect(doc.changed.sort()).toEqual(["owner", "state"]);
    const read = await queryRecords({ kind: "work/work.kind.mjs", cwd: copy });
    if ("error" in read) throw new Error(read.error.message);
    expect(read.records.find((r) => r.id === "W-003")).toMatchObject({ state: "in-progress", valid: true, data: { owner: "agent-1" } });
  });

  test("records review on a work item is refused with review-unsupported: the kind declares no reviews", async () => {
    const doc = await reviewRecord({ kind: "work/work.kind.mjs", id: "W-003", verdict: "agree", by: "alice", cwd: copy });
    expect("error" in doc && doc.error.code).toBe("review-unsupported");
  });

  test("records new with an ask source round-trips through records --json (#2851)", async () => {
    const ask = { said: "Can we add a dark mode toggle to the wireframe?", by: "morgan", at: "2026-09-25T10:00:00Z", via: "hud", session: "hud-9f2" };
    const doc = await newRecord({ kind: resolveWriteKind("work", copy), fields: fresh({ source: { ask } }), cwd: copy });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    const read = await queryRecords({ kind: "work/work.kind.mjs", cwd: copy });
    records.expectValid(read);
    if ("error" in read) throw new Error(read.error.message);
    expect(read.records.find((r) => r.id === doc.id)).toMatchObject({ valid: true, data: { source: { ask } } });
  });
});
