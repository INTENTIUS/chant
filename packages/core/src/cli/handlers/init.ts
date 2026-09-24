import { formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

export async function runInit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  if (args.migrateFrom !== undefined) return runInitFrom(ctx);

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
    template: args.template,
    skill: args.skill,
    force: args.force,
    skipMcp: args.skipMcp,
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

/**
 * `chant init --from <repo>@<ref>[#<member>] [path]` (#2540): copy a template
 * repository at a ref and record its lineage. The template brings its own
 * lexicons and configuration, so `--lexicon` and `--template` do not apply.
 */
async function runInitFrom(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const usage = "Usage: chant init --from <repo>@<ref>[#<member>] [path]";
  if (!args.migrateFrom) {
    console.error(formatError({ message: "--from needs a template: <repo>@<ref>[#<member>]", hint: usage }));
    return 1;
  }
  if (args.lexicon || args.template) {
    console.error(formatError({ message: "--from cannot be combined with --lexicon or --template", hint: usage }));
    return 1;
  }
  const { initFromCommand } = await import("../../workspace/lineage-init");
  const result = await initFromCommand({
    from: args.migrateFrom,
    path: args.path === "." ? undefined : args.path,
    force: args.force,
  });
  if (!result.success) {
    console.error(formatError({ message: result.error ?? "init --from failed", hint: usage }));
    return 1;
  }
  for (const warning of result.warnings) console.error(formatWarning({ message: warning }));
  console.log(formatSuccess("Created:"));
  for (const file of result.createdFiles) console.log(`  ${file}`);
  console.log("");
  console.log(`Lineage: ${result.spec!.id} at ${result.spec!.ref} (${result.commit!.slice(0, 12)}), recorded in .chant/workspace.lock.json`);
  return 0;
}
