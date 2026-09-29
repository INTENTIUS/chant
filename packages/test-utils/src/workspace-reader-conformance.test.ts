import { describe, expect, test } from "vitest";
import { describeWorkspaceReaderConformance, readerCallProblems, sameReadDocument } from "./workspace-reader-conformance";
import { minimalReader } from "./minimal-reader";

describeWorkspaceReaderConformance({ name: "the minimal reader", reader: minimalReader });

// The same reader over chant serve mcp (#2707) is in workspace-reader-conformance.e2e.test.ts (#3019).

describe("readerCallProblems", () => {
  const kind = ["--kind", "decisions/decision.kind.mjs"];

  test("accepts the contract command with its arguments and JSON flag", () => {
    expect(readerCallProblems("records", kind, [["workspace", "records", ...kind, "--json"]])).toEqual([]);
    expect(readerCallProblems("records", kind, [["workspace", "records", "--json", ...kind]])).toEqual([]);
    expect(readerCallProblems("check", [], [["workspace", "check", "--format", "json"]])).toEqual([]);
    expect(readerCallProblems("graph", kind, [["workspace", "graph", ...kind]])).toEqual([]);
    expect(readerCallProblems("graph --intent", ["app/src/server.mjs:19", ...kind], [["workspace", "graph", "--intent", "app/src/server.mjs:19", ...kind, "--json"]])).toEqual([]);
  });

  test("refuses a second call, another command, a missing JSON flag and an added flag", () => {
    expect(readerCallProblems("ls", [], [["workspace", "ls", "--json"], ["workspace", "records", "--json"]])[0]).toMatch(/made 2 chant calls/);
    expect(readerCallProblems("ls", [], [])[0]).toMatch(/made 0 chant calls/);
    expect(readerCallProblems("ls", [], [["approve", "workspace-upgrade", "x"]])[0]).toMatch(/is not workspace ls/);
    expect(readerCallProblems("status", ["dev"], [["workspace", "status", "dev"]])[0]).toMatch(/added nothing/);
    expect(readerCallProblems("records", kind, [["workspace", "records", ...kind, "--json", "--at", "HEAD~1"]])[0]).toMatch(/added --json --at HEAD~1/);
    expect(readerCallProblems("records", kind, [["workspace", "records", "--json"]])[0]).toMatch(/does not pass --kind/);
  });
});

describe("sameReadDocument (#3019)", () => {
  const graph = (cached: boolean, root = "app") => ({ contract: "1", members: [{ name: "app", root, cached }, { name: "docs", root: "docs", skipped: true }] });

  test("a graph member answered from the cache on one side only is the same read", () => {
    expect(sameReadDocument(graph(false), graph(true))).toBe(true);
  });

  test("any other difference, in a member or elsewhere, is not", () => {
    expect(sameReadDocument(graph(false), graph(false, "apps/app"))).toBe(false);
    expect(sameReadDocument({ ...graph(false), contract: "2" }, graph(false))).toBe(false);
    expect(sameReadDocument({ records: [{ cached: true }] }, { records: [{ cached: false }] })).toBe(false);
    expect(sameReadDocument(graph(false), undefined)).toBe(false);
  });
});
