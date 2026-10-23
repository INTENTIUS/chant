/**
 * The `capabilities` tool of `chant serve mcp` (#4375): the capability
 * catalog `chant search` answers `cap:` terms with, as the read contract's
 * `capabilities` document (capabilities.schema.json).
 *
 * Like the workspace reads, it runs the command and returns the document it
 * printed, unchanged: `chant workspace search --capabilities --json` inside a
 * declared workspace, where the workspace's chant runs the rules, and `chant
 * search --capabilities --json` anywhere else. It is served everywhere, since
 * a plain project's agent asks the same questions.
 */
import { findWorkspaceRoot } from "../../../project-root";
import type { ToolDefinition, ToolHandler } from "../types";
import { ownChantCommand, runRead, type ChantCommand } from "../workspace-tools";

export const capabilitiesTool: ToolDefinition = {
  name: "capabilities",
  description:
    "The capability catalog for chant search (capabilities.schema.json, #4375): each capability's name, meaning, parameters, the search term that asks for it (cap:<name> for a set, ->[cap=<name>] for an edge), the questions it answers, whether each lexicon can supply it, what it does not evaluate, and its rule. " +
    "Read it once per session, then ask estate questions with those terms, such as cap:internet-reachable(22) or cap:stores-data <-[cap=reaches]<role>. Not the resource-type catalog: that is the search tool. " +
    "Returns the document chant search --capabilities --json prints (chant workspace search --capabilities --json inside a declared workspace), unchanged.",
  inputSchema: { type: "object", properties: {} },
};

/** The argv the tool runs in `cwd`: the workspace form inside a declared workspace. */
export function capabilitiesArgv(cwd: string): string[] {
  return findWorkspaceRoot(cwd) ? ["workspace", "search", "--capabilities", "--json"] : ["search", "--capabilities", "--json"];
}

export function createCapabilitiesHandler(cwd: string, command: ChantCommand = ownChantCommand()): ToolHandler {
  return async () => runRead(command, capabilitiesArgv(cwd), cwd);
}
