import { describe, expect, test } from "vitest";
import { describeWorkspaceReaderConformance, readerCallProblems, type ChantTransport, type ReadContractCommand } from "./workspace-reader-conformance";

/**
 * The smallest reader that conforms (#2657): it runs the contract command
 * with the command's JSON flag and parses what chant prints. The read-contract
 * page shows the same reader.
 */
function minimalReader(chant: ChantTransport) {
  const jsonFlag: Record<ReadContractCommand, string[]> = {
    ls: ["--json"],
    graph: [],
    check: ["--format", "json"],
    status: ["--json"],
    records: ["--json"],
    "graph --intent": ["--json"],
    "graph --composites": ["--json"],
  };
  return {
    async read(command: ReadContractCommand, args: string[]) {
      const run = await chant.run(["workspace", ...command.split(" "), ...args, ...jsonFlag[command]]);
      return JSON.parse(run.stdout) as unknown;
    },
  };
}

describeWorkspaceReaderConformance({ name: "the minimal reader", reader: minimalReader });

// The same reader, its calls answered by chant serve mcp's workspace tools (#2707): each tool's
// document must be the one the command prints.
describeWorkspaceReaderConformance({ name: "the minimal reader", reader: minimalReader, over: "mcp" });

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
