/**
 * `chant ci` (#3573, ws-103): which commits passed CI.
 *
 *   ci last-green [--json]               the newest commit on the branch with a green tag and no revoked tag
 *   ci tick [--dry-run] [--forge github] tag the commits that turned green, revoke the ones that turned red
 *   ci workflow [--workflow <name>]... [--output <file>]
 *                                        write the root CI file that runs the tick
 *
 * `last-green --json` prints `ci-last-green.schema.json`. The tick and the
 * workflow print text.
 */

import { realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { findWorkspaceRoot } from "../project-root";
import { ciTick, CiGreenError, formatTick, lastGreen } from "./ci-green";
import { ciForgeFromEnv } from "./ci-green-forge";
import { CI_GREEN_WORKFLOW_FILE, ciGreenHeader, readWorkflowSources, renderCiGreenWorkflow, workflowsHolding, writeWorkflowFile } from "./ci-green-workflow";
import { readDeclaration, readerVersion, WorkspaceReadError } from "./declaration";
import { recordGeneratedFiles, resolveMemberContext, shellArg } from "./member-pipeline";
import { gitTop, workingTree } from "./tree";

const USAGE = "chant ci last-green [--json] | ci tick [--dry-run] [--forge github] | ci workflow [--workflow <name>]... [--output <file>]";

export async function runCiLastGreen(ctx: CommandContext): Promise<number> {
  const doc = lastGreen({ cwd: process.cwd() });
  if (ctx.args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  }
  if ("error" in doc) {
    console.error(formatError({ message: doc.error.message, hint: USAGE }));
    return 1;
  }
  if (!doc.commit) {
    console.error(`No first-parent commit of ${doc.ref} has a ci/green tag without a ci/revoked one. Fetch the tags first: git fetch origin --tags`);
    return 1;
  }
  console.log(doc.commit.sha);
  return 0;
}

const describe = (err: unknown) => (err instanceof WorkspaceReadError ? err.describe() : err instanceof Error ? err.message : String(err));

export async function runCiTick(ctx: CommandContext): Promise<number> {
  try {
    const forge = ciForgeFromEnv(ctx.args.forge ?? "github");
    const result = await ciTick({ cwd: process.cwd(), forge, dryRun: ctx.args.dryRun === true });
    console.log(formatTick(result, ctx.args.dryRun === true));
    return 0;
  } catch (err) {
    console.error(formatError({ message: `chant ci tick: ${describe(err)}`, hint: USAGE }));
    return 1;
  }
}

export async function runCiWorkflow(ctx: CommandContext): Promise<number> {
  const cwd = process.cwd();
  try {
    const found = findWorkspaceRoot(cwd);
    if (!found) throw new WorkspaceReadError("declaration-missing", "no chant.workspace.json or .jsonc between this directory and the git root");
    const declaration = readDeclaration(workingTree(found.dir));
    const green = declaration.ci?.green;
    if (!green) throw new CiGreenError("ci-green-undeclared", `${declaration.file} declares no ci.green, so there is nothing for the workflow to run`);
    // git reports its top with symlinks resolved (/private/var on macOS), so resolve the root too.
    const root = realpathSync(found.dir);
    const repoRoot = gitTop(root) ?? root;
    const member = resolveMemberContext(cwd, found);
    const target = ctx.args.output ? resolve(realpathSync(cwd), ctx.args.output) : join(repoRoot, CI_GREEN_WORKFLOW_FILE);
    const fromRepo = relative(repoRoot, target).split(sep).join("/");

    const scan = workflowsHolding(green, readWorkflowSources(repoRoot, fromRepo));
    const extra = ctx.args.ciWorkflows ?? [];
    const workflows = [...new Set([...scan.workflows, ...extra])].sort();
    for (const f of scan.unreadable) console.error(`warning: ${f} is not valid YAML, so its jobs were not read`);
    for (const u of scan.unmatched) console.error(`warning: no job in .github/workflows/ reports a check run matching ${JSON.stringify(u.pattern)} (phase ${u.phase}); pass --workflow <name> for the workflow that does`);
    if (workflows.length === 0) {
      throw new Error("no workflow in .github/workflows/ holds a check run of a required phase, so nothing would trigger the tick but its schedule; name one with --workflow <name>");
    }

    const base = member ? member.memberRoot : root;
    const parts = ["chant", "ci", "workflow", ...extra.flatMap((w) => ["--workflow", w])];
    if (ctx.args.output) parts.push("--output", relative(base, target).split(sep).join("/"));
    const command = parts.map(shellArg).join(" ");
    const workspaceRoot = relative(repoRoot, root).split(sep).join("/") || ".";
    const yaml = renderCiGreenWorkflow({ green, workflows, chantVersion: readerVersion(), workspaceRoot });
    const written = writeWorkflowFile(target, ciGreenHeader(command, member ? "member" : "root") + yaml);
    if (member) recordGeneratedFiles(member.memberRoot, [{ path: fromRepo, command }]);
    console.log(`Wrote ${written}: ticks when ${workflows.join(", ")} complete${workflows.length === 1 ? "s" : ""} on ${green.branch}, and every 15 minutes.`);
    return 0;
  } catch (err) {
    console.error(formatError({ message: `chant ci workflow: ${describe(err)}`, hint: USAGE }));
    return 1;
  }
}
