import { resolve } from "node:path";
import { formatError, formatSuccess } from "../format";
import type { CommandContext } from "../registry";

export async function runDevGenerate(ctx: CommandContext): Promise<number> {
  for (const plugin of ctx.plugins) {
    await plugin.generate({ verbose: ctx.args.verbose });
    console.error(formatSuccess(`${plugin.name}: generate complete`));
    await plugin.validate({ verbose: ctx.args.verbose });
    console.error(formatSuccess(`${plugin.name}: validate complete`));
    await plugin.coverage({ verbose: ctx.args.verbose });
    console.error(formatSuccess(`${plugin.name}: coverage complete`));
  }
  return 0;
}

export async function runDevPublish(ctx: CommandContext): Promise<number> {
  for (const plugin of ctx.plugins) {
    await plugin.package({ verbose: ctx.args.verbose, force: ctx.args.force });
    console.error(formatSuccess(`${plugin.name}: publish complete`));
  }
  return 0;
}

export async function runDevOnboard(ctx: CommandContext): Promise<number> {
  const name = ctx.args.extraPositional;
  if (!name) {
    console.error(formatError({
      message: "Missing lexicon name",
      hint: "Usage: chant dev onboard <name>",
    }));
    return 1;
  }

  const { onboardCommand, printOnboardResult } = await import("../commands/onboard");
  const result = onboardCommand({ name, verbose: ctx.args.verbose });
  await printOnboardResult(result, name);
  return result.success ? 0 : 1;
}

export async function runDevCheckLexicon(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.extraPositional ?? ".";
  const { checkLexicon, printCheckResult } = await import("../commands/check-lexicon");
  const result = checkLexicon(resolve(dir));
  printCheckResult(result, ctx.args.format === "json");
  return result.tier1Pass ? 0 : 1;
}

export async function runDevSurfaceDiff(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.extraPositional ?? ".";
  const { runSurfaceDiff, printSurfaceDiffResult } = await import("../commands/lexicon-surface-diff");
  const result = await runSurfaceDiff({
    lexiconDir: resolve(dir),
    force: ctx.args.force,
    verbose: ctx.args.verbose,
    runExamples: ctx.args.runExamples,
    pinnedDigestPath: ctx.args.pinnedDigest,
    updateSnapshot: ctx.args.updateSnapshot,
  });
  printSurfaceDiffResult(result, ctx.args.format === "json");
  return result.ok ? 0 : 1;
}

export async function runDevPinnedUpgrade(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.extraPositional ?? ".";
  const { runPinnedUpgrade, printPinnedUpgradeResult } = await import("../commands/pinned-upgrade");
  const result = await runPinnedUpgrade({
    lexiconDir: resolve(dir),
    force: ctx.args.force,
    verbose: ctx.args.verbose,
  });
  printPinnedUpgradeResult(result, ctx.args.format === "json");
  // Exit non-zero when the upstream query failed or the regen validation broke.
  if (result.fetchError) return 1;
  if (result.validation && !result.validation.ok) return 1;
  return 0;
}

export async function runDevRollingUpgrade(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.extraPositional ?? ".";
  const { runRollingUpgrade, printRollingUpgradeResult } = await import("../commands/lexicon-rolling-upgrade");
  const result = await runRollingUpgrade({
    lexiconDir: resolve(dir),
    force: ctx.args.force,
    verbose: ctx.args.verbose,
  });
  printRollingUpgradeResult(result, ctx.args.format === "json");
  return result.validationOk ? 0 : 1;
}

export async function runDevUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown dev subcommand: ${ctx.args.path}`,
    hint: "Available: chant dev generate, chant dev publish, chant dev onboard, chant dev check-lexicon, chant dev surface-diff, chant dev pinned-upgrade, chant dev rolling-upgrade",
  }));
  return 1;
}
