import { formatError } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant e2e safe-run [--scan <dir>]... -- <command...>";

/** `chant e2e <word>` with a word that is not a verb. */
export async function runE2eUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({ message: `Unknown e2e command: ${ctx.args.path}`, hint: USAGE }));
  return 2;
}

/**
 * `chant e2e safe-run [--scan <dir>]... -- <command...>` (chant#4587, C1): the
 * harness's no-real-cloud wrapper (`../../e2e-harness/safe-run.ts`) for a
 * driver that is not TypeScript. Exit codes: the command's own code after a
 * CLEAN scan, 3 when the scan rejects the run, 2 for a usage error or a
 * refused environment.
 */
export async function runE2eSafeRun(ctx: CommandContext): Promise<number> {
  const command = (ctx.args.positionals ?? []).slice(1);
  if (command.length === 0) {
    console.error(formatError({ message: "chant e2e safe-run needs a command after --", hint: USAGE }));
    return 2;
  }
  const { runSafeRunCommand } = await import("../../e2e-harness/safe-run-cli");
  return runSafeRunCommand({ command, scan: ctx.args.scanDirs ?? [] });
}
