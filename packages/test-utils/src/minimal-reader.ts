import type { ChantTransport, ReadContractCommand } from "./workspace-reader-conformance";

/**
 * The smallest reader that conforms (#2657): it runs the contract command
 * with the command's JSON flag and parses what chant prints. The read-contract
 * page shows the same reader. Shared by the CLI run of the conformance suite
 * (workspace-reader-conformance.test.ts) and the MCP run
 * (workspace-reader-conformance.e2e.test.ts).
 */
export function minimalReader(chant: ChantTransport) {
  const jsonFlag: Record<ReadContractCommand, string[]> = {
    ls: ["--json"],
    graph: [],
    check: ["--format", "json"],
    status: ["--json"],
    records: ["--json"],
    "records --uncommitted": ["--json"],
    "graph --intent": ["--json"],
    "graph --composites": ["--json"],
    runs: ["--json"],
  };
  return {
    async read(command: ReadContractCommand, args: string[]) {
      const run = await chant.run(["workspace", ...command.split(" "), ...args, ...jsonFlag[command]]);
      return JSON.parse(run.stdout) as unknown;
    },
  };
}
