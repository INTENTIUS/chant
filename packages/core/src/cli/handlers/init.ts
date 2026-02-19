import { formatError } from "../format";
import type { CommandContext } from "../registry";

export async function runInit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  if (!args.lexicon) {
    console.error(formatError({
      message: "Missing --lexicon flag",
      hint: "Usage: chant init --lexicon <name>",
    }));
    return 1;
  }

  const { initCommand, printInitResult } = await import("../commands/init");
  const result = await initCommand({
    path: args.path === "." ? undefined : args.path,
    lexicon: args.lexicon,
    force: args.force,
    skipInstall: true,
  });
  await printInitResult(result, { skipInstall: false, cwd: args.path });
  return result.success ? 0 : 1;
}

export async function runInitLexicon(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  const name = args.extraPositional;
  if (!name) {
    console.error(formatError({
      message: "Missing lexicon name",
      hint: "Usage: chant init lexicon <name> [path]",
    }));
    return 1;
  }

  const { initLexiconCommand, printInitLexiconResult } = await import("../commands/init-lexicon");
  const result = await initLexiconCommand({
    name,
    path: args.extraPositional2,
    force: args.force,
  });
  await printInitLexiconResult(result);
  return result.success ? 0 : 1;
}
