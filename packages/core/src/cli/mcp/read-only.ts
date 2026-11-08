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
 * declare `readOnly: true`. The `--propose` tier (chant#4655) keeps these
 * lists and adds only a product's `forgeWrite` tools (./product-tools.ts).
 */

import { workspaceReadTools, workspaceWriteTools } from "./workspace-tools";
import { ledgerReadTools } from "./ledger-tools";
import { reportReadTools } from "./report-tools";
import type { McpToolContribution, ToolAnnotations } from "../../mcp/types";

/** The annotations of a tool that changes nothing (chant#4823). */
export const READ_ONLY_ANNOTATIONS: Readonly<ToolAnnotations> = Object.freeze({ readOnlyHint: true, destructiveHint: false });

/** The annotations of a product's `forgeWrite` tool, which adds a pull request or a comment and deletes nothing (chant#4823). */
export const FORGE_WRITE_ANNOTATIONS: Readonly<ToolAnnotations> = Object.freeze({ readOnlyHint: false, destructiveHint: false });

/**
 * A contributed tool's annotations in `tools/list` (chant#4823): its own,
 * with `readOnlyHint` and `destructiveHint` set from `readOnly: true` or
 * `forgeWrite: true`, so a hint never says more than the rule the server
 * serves the tool by. Undefined when the tool gives and declares nothing.
 */
export function contributedToolAnnotations(tool: Pick<McpToolContribution, "readOnly" | "forgeWrite" | "annotations">): ToolAnnotations | undefined {
  const declared = tool.readOnly === true ? READ_ONLY_ANNOTATIONS : tool.forgeWrite === true ? FORGE_WRITE_ANNOTATIONS : undefined;
  if (!declared && !tool.annotations) return undefined;
  return { ...tool.annotations, ...declared };
}

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
