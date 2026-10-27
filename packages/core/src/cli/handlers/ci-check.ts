/**
 * `chant ci check --base <rev> [<target>...] [--output <dir>] [--json]`
 * (#4556): run the `ci.hooks.check` hooks the workspace declaration at
 * `--base` names, as a product's check job does. Each target is a root,
 * stack or component the change touches; a `perRun` hook runs once per
 * target. Exits 0 when every hook passed or none is declared, 1 when one
 * failed. See `../../components/check-hooks.ts`.
 */
import { formatError } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant ci check --base <rev> [<target>...] [--output <dir>] [--json]";

export async function runCiCheck(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (!args.base) {
    console.error(formatError({ message: "chant ci check needs --base <rev>, the commit the change is measured from", hint: `${USAGE}. The hooks are read at base, so a change cannot remove a required check.` }));
    return 1;
  }
  const targets = (args.positionals ?? []).slice(1);
  const { runCheckHooks } = await import("../../components/check-hooks");
  let report;
  try {
    report = runCheckHooks({ base: args.base, targets, ...(args.output ? { dir: args.output } : {}) });
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return 1;
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (report.status === "none") console.error("ci check: no ci.hooks.check at base, so nothing ran");
  else console.error(`ci check: ${report.hooks.filter((h) => h.outcome === "passed").length} passed, ${report.hooks.filter((h) => h.outcome === "failed").length} failed, ${report.hooks.filter((h) => h.outcome === "skipped").length} skipped`);
  return report.status === "failed" ? 1 : 0;
}
