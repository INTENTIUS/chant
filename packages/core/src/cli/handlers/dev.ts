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

export async function runDevUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: `Unknown dev subcommand: ${ctx.args.path}`,
    hint: "Available: chant dev generate, chant dev publish, chant dev onboard, chant dev check-lexicon",
  }));
  return 1;
}
