/**
 * The writer conformance suite's checks on their own (#3159): the calls a
 * step may make, the changes a step may leave, the state a writer may keep,
 * and the fixture it writes to. No chant runs here; the suite run end to end
 * is writer-conformance.e2e.test.ts.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildStep,
  isReadCall,
  reportedWrites,
  selectActions,
  undeclaredState,
  unreportedChanges,
  WRITE_CONTRACT_ACTIONS,
  WRITE_CONTRACT_SCHEMAS,
  writeArgv,
  writeContractSchema,
  writerCallProblems,
  writerDocumentProblems,
  WRITER_FIXTURE_DIR,
  WRITER_SCRIPT,
  type ChantRun,
  type WriteStep,
} from "./index";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..", "..");

const review = buildStep(WRITER_SCRIPT.find((s) => s.id === "review")!, { decision: { id: "fix-002" } });
const decision = buildStep(WRITER_SCRIPT.find((s) => s.id === "decision")!, {});
const run = (argv: string[], input?: string, stdout = ""): ChantRun => ({ argv, ...(input === undefined ? {} : { input }), status: 0, stdout, stderr: "" });

describe("the script (#3159)", () => {
  test("covers every write-contract action, and each action has a schema that ships", () => {
    expect(new Set(WRITER_SCRIPT.map((s) => s.action))).toEqual(new Set(WRITE_CONTRACT_ACTIONS));
    for (const a of WRITE_CONTRACT_ACTIONS) expect(writeContractSchema(a).schema.$id, a).toMatch(new RegExp(`/${WRITE_CONTRACT_SCHEMAS[a].replace(".", "\\.")}$`));
  });

  test("writeArgv: fields go on stdin, everything else is a flag", () => {
    expect(review.args).toEqual(["fix-002", "--kind", "decisions/decision.kind.mjs", "--verdict", "agree", "--by", "conformance-reviewer", "--note", "Written through chant, read back after amnesia."]);
    expect(review.input).toBeUndefined();
    expect(decision.args).toEqual(["decisions/decision.kind.mjs", "--from", "-"]);
    expect(JSON.parse(decision.input!)).toMatchObject({ title: "How a writer writes the workspace", state: "proposed" });
    expect(writeArgv("work evidence", { id: "W-001", kind: "work/work.kind.mjs", holder: "h", token: "t", entry: { criterion: "AC-1" } })).toEqual({
      args: ["W-001", "--holder", "h", "--token", "t", "--from", "-", "--kind", "work/work.kind.mjs"],
      input: '{"criterion":"AC-1"}',
    });
    expect(writeArgv("runs end", { id: "r", fields: {} })).toEqual({ args: ["r", "--from", "-"], input: "{}" });
    expect(writeArgv("box listing set", { member: "app", fields: { title: "T" }, cover: "/in/cover.png" })).toEqual({
      args: ["app", "--from", "-", "--cover", "/in/cover.png"],
      input: '{"title":"T"}',
    });
    const listing = buildStep(WRITER_SCRIPT.find((s) => s.id === "listing")!, {}, { dir: "/in" });
    expect(listing.args).toEqual(["app", "--from", "-", "--cover", "/in/cover.png"]);
    expect(buildStep(WRITER_SCRIPT.find((s) => s.id === "listing")!, {}).args).toEqual(["app", "--from", "-"]);
  });

  test("a later step's params come from the documents of the steps before it", () => {
    const renew = buildStep(WRITER_SCRIPT.find((s) => s.id === "renew")!, { claim: { lease: { token: "tok-1" } } });
    expect(renew.args).toEqual(["W-001", "--holder", "conformance-writer", "--token", "tok-1", "--kind", "work/work.kind.mjs"]);
  });

  test("selectActions refuses a name that is not an action, and an empty list", () => {
    expect(selectActions(["records review", "points answer"])).toEqual({
      checked: ["records review", "points answer"],
      skipped: WRITE_CONTRACT_ACTIONS.filter((a) => a !== "records review" && a !== "points answer"),
    });
    expect(() => selectActions(["records pin" as never])).toThrow(/not write-contract actions: records pin/);
    expect(() => selectActions([])).toThrow(/actions is empty/);
  });
});

describe("writerCallProblems (#3159)", () => {
  test("exactly one call of the action, its arguments in order, its JSON flag, its fields on stdin", () => {
    expect(writerCallProblems(review, [run(["workspace", "records", "review", ...review.args])])).toEqual([]);
    expect(writerCallProblems(review, [run(["workspace", "records", "review", ...review.args, "--json"])])).toEqual([]);
    expect(writerCallProblems(decision, [run(["workspace", "records", "new", ...decision.args], JSON.stringify(JSON.parse(decision.input!), null, 2))])).toEqual([]);
  });

  test("a second call, another command, an extra flag, other fields or stdin for a command that reads none", () => {
    const argv = ["workspace", "records", "review", ...review.args];
    expect(writerCallProblems(review, [run(["workspace", "ls", "--json"]), run(argv)])[0]).toMatch(/^review \(records review\): made 2 chant calls .* expected exactly one$/);
    expect(writerCallProblems(review, [run(["workspace", "records", "amend", ...review.args])])[0]).toMatch(/which is not workspace records review/);
    expect(writerCallProblems(review, [run([...argv, "--dry-run"])])[0]).toMatch(/it may add only nothing or --json, and it added --dry-run/);
    expect(writerCallProblems(review, [run(argv, "{}")])[0]).toMatch(/gave chant .* something on stdin, and the command reads nothing there/);
    expect(writerCallProblems(decision, [run(["workspace", "records", "new", ...decision.args], '{"title":"other"}')])[0]).toMatch(/other fields on stdin than the step's/);
  });
});

describe("writerDocumentProblems (#3159)", () => {
  test("a refusal, a changed document and one that does not validate", () => {
    const refusal = { $schema: writeContractSchema("records review").schema.$id, contract: 1, error: { code: "record-not-found", message: "no fix-002" } };
    const printed = run(["workspace", "records", "review"], undefined, JSON.stringify(refusal));
    expect(writerDocumentProblems(review, printed, refusal)).toEqual(["review (records review): chant did not write: record-not-found: no fix-002"]);
    expect(writerDocumentProblems(review, printed, { ...refusal, extra: 1 }).join("\n")).toMatch(/must return the document chant printed, unchanged/);
    const bad = { $schema: refusal.$schema, contract: 2 };
    expect(writerDocumentProblems(review, run([], undefined, JSON.stringify(bad)), bad).join("\n")).toMatch(/does not validate against records-review.schema.json/);
    expect(writerDocumentProblems(review, run(["workspace"], undefined, ""), undefined)).toEqual(["review (records review): chant workspace printed nothing"]);
  });
});

describe("unreportedChanges (#3159)", () => {
  const files = (o: Record<string, string>) => o;
  test("a record write may change only the path it reports, and no ref", () => {
    const doc = { path: "decisions/fix-002-x.md" };
    expect(unreportedChanges(review, doc, { before: files({ a: "1" }), after: files({ a: "1", "decisions/fix-002-x.md": "2" }) }, { before: { HEAD: "m 1" }, after: { HEAD: "m 1" } })).toEqual([]);
    expect(unreportedChanges(review, doc, { before: files({ a: "1" }), after: files({ a: "9", "notes.md": "2" }) }, { before: { HEAD: "m 1" }, after: { HEAD: "m 2" } })).toEqual([
      "review (records review): files changed that chant did not report writing: a (changed), notes.md (added)",
      "review (records review): git refs changed that chant did not report writing: HEAD",
    ]);
  });

  test("a lease may move its ref and chant/lifecycle to the commit it reports; a run only chant/lifecycle", () => {
    const claim = buildStep(WRITER_SCRIPT.find((s) => s.id === "claim")!, {});
    const doc = { ref: "refs/chant/lease/work/W-001", history: { commit: "c2" } };
    expect(reportedWrites("work claim", doc)).toEqual({ paths: [], refs: { "refs/heads/chant/lifecycle": "c2", "refs/chant/lease/work/W-001": "*" } });
    expect(reportedWrites("box listing set", { paths: ["app/listing/cover.png", "chant.workspace.json"], declaration: { path: "chant.workspace.json" } })).toEqual({ paths: ["app/listing/cover.png", "chant.workspace.json"], refs: {} });
    const before = { "refs/heads/chant/lifecycle": "c1", HEAD: "m 1" };
    expect(unreportedChanges(claim, doc, { before: {}, after: {} }, { before, after: { ...before, "refs/heads/chant/lifecycle": "c2", "refs/chant/lease/work/W-001": "b" } })).toEqual([]);
    expect(unreportedChanges(claim, doc, { before: {}, after: {} }, { before, after: { ...before, "refs/heads/chant/lifecycle": "c3" } })[0]).toMatch(/git refs changed that chant did not report writing: refs\/heads\/chant\/lifecycle/);
    const start = { id: "run-start", action: "runs start", params: { run: {} }, args: ["--from", "-"], input: "{}" } as WriteStep;
    expect(unreportedChanges(start, { ledger: { commit: "c2" } }, { before: {}, after: {} }, { before, after: { ...before, "refs/heads/chant/lifecycle": "c2" } })).toEqual([]);
  });
});

describe("state and reads (#3159)", () => {
  test("undeclaredState: everything in the state directory is declared, as one of ws-074's four", () => {
    expect(undeclaredState(["hud/events.db", "hud/events.db-wal"], [{ path: "hud", is: "cache" }])).toEqual([]);
    expect(undeclaredState(["events.db", "notes.json"], [{ path: "events.db", is: ["cache", "telemetry"] }])).toEqual([
      "state: the writer keeps notes.json in its state directory, and privateState does not declare it",
    ]);
    expect(undeclaredState([], [{ path: "db", is: "database" as never }])[0]).toMatch(/private state is cache, telemetry, secret, runtime/);
  });

  test("isReadCall: the read contract, never a write verb", () => {
    for (const argv of [["workspace", "records", "--kind", "k", "--json"], ["workspace", "records", "--uncommitted", "--json"], ["workspace", "runs", "--json"], ["workspace", "points", "--open", "--json"], ["workspace", "work", "history", "W-001"], ["workspace", "ls", "--json"]]) {
      expect(isReadCall(argv), argv.join(" ")).toBe(true);
    }
    for (const argv of [["workspace", "records", "new"], ["workspace", "runs", "start"], ["workspace", "points", "answer"], ["workspace", "points", "retract"], ["workspace", "work", "claim"], ["workspace", "work", "evidence"], ["build"]]) {
      expect(isReadCall(argv), argv.join(" ")).toBe(false);
    }
  });
});

describe("the writer fixture (#3159)", () => {
  test("its kinds, schemas and decision points are the reference workspace's", () => {
    const same: [string, string][] = [
      ["work/work.kind.mjs", "work/work.kind.mjs"],
      ["work/work.schema.json", "work/work.schema.json"],
      ["answers/answer.kind.mjs", "answers/answer.kind.mjs"],
      ["answers/answer.schema.json", "answers/answer.schema.json"],
      ["decisions/points.json", "decisions/points.json"],
      ["sessions/session.schema.json", "design/sessions/session.schema.json"],
      // The session kind's other subject kinds (#3148).
      ["contracts/contract.kind.mjs", "design/contracts/contract.kind.mjs"],
      ["contracts/contract.schema.json", "design/contracts/contract.schema.json"],
      ["drivers/driver.kind.mjs", "design/drivers/driver.kind.mjs"],
      ["drivers/driver.schema.json", "design/drivers/driver.schema.json"],
    ];
    for (const [ours, theirs] of same) expect(readFileSync(join(WRITER_FIXTURE_DIR, ours), "utf-8"), ours).toBe(readFileSync(join(repoRoot, "reference-workspace", theirs), "utf-8"));
    // The session kind sits one directory higher here than in the reference
    // workspace's design member, so its subjects path is one level shorter.
    const session = readFileSync(join(repoRoot, "reference-workspace", "design", "sessions", "session.kind.mjs"), "utf-8").replace('"../../decisions/decision.kind.mjs"', '"../decisions/decision.kind.mjs"');
    expect(readFileSync(join(WRITER_FIXTURE_DIR, "sessions", "session.kind.mjs"), "utf-8")).toBe(session);
  });
});
