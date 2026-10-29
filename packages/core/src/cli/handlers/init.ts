import { formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

export async function runInit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  if (args.migrateFrom !== undefined) return runInitFrom(ctx);

  // chant#4655 — --propose registers the read-only server's propose tier, so it needs --mcp-read-only.
  if (args.propose === true && args.mcpReadOnly !== true) {
    console.error(formatError({
      message: "chant init --propose needs --mcp-read-only",
      hint: "Usage: chant init --mcp-read-only --propose (registers chant serve mcp --read-only --propose in .mcp.json)",
    }));
    return 1;
  }

  // chant#4655 — --dry-run prints the .mcp.json init would register and writes nothing.
  if (args.dryRun === true) {
    const { detectPackageManager, generateMcpConfig } = await import("../mcp-config");
    const target = args.path === "." || args.path === undefined ? process.cwd() : args.path;
    console.log(generateMcpConfig(detectPackageManager(target), { readOnly: args.mcpReadOnly, propose: args.propose }));
    return 0;
  }

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
    mcpReadOnly: args.mcpReadOnly,
    mcpPropose: args.propose,
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
 * `chant init --from <repo>@<ref>[#<member>] [--param <name>=<value>]... [path]`
 * (#2540, #2627): copy a template repository at a ref, substitute the
 * parameters its `chant.template.json` declares, and record its lineage.
 * `--from <dir>[#<member>]` copies a template directory on disk instead (#2647).
 * The template brings its own lexicons and configuration, so `--lexicon` and
 * `--template` do not apply.
 */
async function runInitFrom(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const usage = "Usage: chant init --from <repo>@<ref>[#<member>] | <dir>[#<member>] [--param <name>=<value>]... [path]";
  if (!args.migrateFrom) {
    console.error(formatError({ message: "--from needs a template: <repo>@<ref>[#<member>] or <dir>[#<member>]", hint: usage }));
    return 1;
  }
  if (args.lexicon || args.template) {
    console.error(formatError({ message: "--from cannot be combined with --lexicon or --template", hint: usage }));
    return 1;
  }
  if (args.paramsFile) {
    console.error(formatError({ message: "--params-file does not apply to init --from; pass each value with --param <name>=<value>", hint: usage }));
    return 1;
  }
  const { parseParamArgs } = await import("../../workspace/template-manifest");
  let params: Record<string, string>;
  try {
    params = parseParamArgs(args.param ?? []);
  } catch (err) {
    console.error(formatError({ message: (err as Error).message, hint: usage }));
    return 1;
  }
  const { initFromCommand } = await import("../../workspace/lineage-init");
  const result = await initFromCommand({
    from: args.migrateFrom,
    path: args.path === "." ? undefined : args.path,
    force: args.force,
    params,
  });
  if (!result.success) {
    console.error(formatError({ message: result.error ?? "init --from failed", hint: usage }));
    return 1;
  }
  for (const warning of result.warnings) console.error(formatWarning({ message: warning }));
  console.log(formatSuccess("Created:"));
  for (const file of result.createdFiles) console.log(`  ${file}`);
  console.log("");
  const from = result.spec
    ? `${result.spec.id} at ${result.spec.ref} (${result.commit!.slice(0, 12)})`
    : `${result.template} (a directory, recorded by digest only)`;
  console.log(`Lineage: ${from}, recorded in .chant/workspace.lock.json`);
  const parameters = Object.entries(result.parameters ?? {});
  if (parameters.length > 0) console.log(`Parameters: ${parameters.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`);
  return 0;
}
