/**
 * chant#4543 — which tools `chant serve mcp --read-only` serves.
 *
 * A read-only server registers no tool that runs an Op, resolves a gate,
 * writes a file or a record, or captures a snapshot to the store. The core
 * tools are sorted here by name, once, so the server and its guard test read
 * the same lists: a core tool missing from both lists is refused at
 * registration in read-only mode, so a new tool has to be put on one side
 * before it can ship.
 *
 * Contributed tools (a lexicon's `mcpTools()`, and a product's tools through
 * the hook chant#4555 adds, ./product-tools.ts) are served only when they
 * declare `readOnly: true`.
 */

import { workspaceReadTools, workspaceWriteTools } from "./workspace-tools";
import { ledgerReadTools } from "./ledger-tools";
import { reportReadTools } from "./report-tools";

/**
 * Core tools that change nothing, served in both modes.
 *
 * `build` returns its output and writes no file (its `output` parameter is
 * ignored), and `lifecycle-diff` reads the last snapshot without writing one.
 * `lint` is here with its `fix` parameter taken away: the read-only server
 * serves a `lint` whose schema has no `fix` and which refuses one.
 */
export const READ_ONLY_CORE_TOOLS: ReadonlySet<string> = new Set([
  "build",
  "lint",
  "explain",
  "search",
  "composites",
  "capabilities",
  "lifecycle-diff",
  "op-list",
  "op-status",
  "op-report",
  ...ledgerReadTools.map((t) => t.name),
  ...reportReadTools.map((t) => t.name),
  ...workspaceReadTools.map((t) => t.name),
]);

/** Core tools that run, resolve or write something. Never served in read-only mode. */
export const MUTATING_CORE_TOOLS: ReadonlySet<string> = new Set([
  "import",
  "scaffold",
  "lifecycle-snapshot",
  "op-run",
  "op-approve",
  ...workspaceWriteTools.map((t) => t.name),
]);

/** Whether a contributed tool is served in the given mode: always by the ordinary server, only when it declares `readOnly: true` by the read-only one. */
export function servesContributedTool(tool: { readOnly?: boolean }, readOnly: boolean): boolean {
  return !readOnly || tool.readOnly === true;
}

/** The refusal a read-only server gives a core tool registration that is not on the read side. */
export class ReadOnlyRegistrationError extends Error {
  constructor(name: string) {
    super(
      `chant serve mcp --read-only refused to register "${name}": it is not one of the read-only core tools ` +
        `(packages/core/src/cli/mcp/read-only.ts). A tool that changes nothing goes in READ_ONLY_CORE_TOOLS; one that runs or writes goes in MUTATING_CORE_TOOLS.`,
    );
    this.name = "ReadOnlyRegistrationError";
  }
}
