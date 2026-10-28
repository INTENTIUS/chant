/**
 * `chant ci check --base <rev> [<target>...] [--output <dir>] [--json]`
 * (#4556): run the `ci.hooks.check` hooks the workspace declaration at
 * `--base` names, as a product's check job does. Each target is a root,
 * stack or component the change touches; a `perRun` hook runs once per
 * target. Then each lexicon the project lists runs its own check steps for
 * the members of its kinds (#4633, `LexiconPlugin.checkSteps`): the pulumi
 * lexicon's `pulumi install`, stack config check and `pulumi about`. Exits 0
 * when every hook and step passed or there were none, 1 (`failed`) when one
 * failed. See `../../components/check-hooks.ts` and
 * `../../components/check-steps.ts`.
 */
import { resolve } from "node:path";
import type { CheckStepsAdapter } from "../../components/check-steps";
import { CHANT_EXIT } from "../../exit-codes";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/**
 * The check steps of the lexicons the project at `cwd` lists, best effort:
 * a directory with no chant project, or a lexicon that does not load, gives
 * none, and the hooks still run.
 */
async function lexiconCheckSteps(ctx: CommandContext, cwd: string): Promise<CheckStepsAdapter[]> {
  let plugins = ctx.plugins ?? [];
  if (plugins.length === 0) {
    try {
      const { loadPlugins, resolveProjectLexicons } = await import("../plugins");
      plugins = await loadPlugins(await resolveProjectLexicons(resolve(cwd)));
    } catch {
      plugins = [];
    }
  }
  return plugins.map((p) => p.checkSteps?.()).filter((a): a is CheckStepsAdapter => a !== undefined);
}

const USAGE = "chant ci check --base <rev> [<target>...] [--output <dir>] [--json]";

export async function runCiCheck(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (!args.base) {
    console.error(formatError({ message: "chant ci check needs --base <rev>, the commit the change is measured from", hint: `${USAGE}. The hooks are read at base, so a change cannot remove a required check.` }));
    return 1;
  }
  const targets = (args.positionals ?? []).slice(1);
  const { runCheckStage } = await import("../../components/check-steps");
  let report;
  try {
    const adapters = await lexiconCheckSteps(ctx, process.cwd());
    report = await runCheckStage({ base: args.base, targets, adapters, ...(args.output ? { dir: args.output } : {}) });
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return CHANT_EXIT.failed;
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (report.status === "none") console.error("ci check: no ci.hooks.check at base and no lexicon check step, so nothing ran");
  else {
    const all = [...report.hooks, ...(report.steps ?? [])];
    console.error(`ci check: ${all.filter((h) => h.outcome === "passed").length} passed, ${all.filter((h) => h.outcome === "failed").length} failed, ${all.filter((h) => h.outcome === "skipped").length} skipped`);
    if (report.failed) console.error(`ci check: ${report.failed}`);
  }
  return report.status === "failed" ? CHANT_EXIT.failed : CHANT_EXIT.done;
}
