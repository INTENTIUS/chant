import { migrateCommand, printMigrateResult } from "../commands/migrate";
import { formatError } from "../format";
import { loadPlugins } from "../plugins";
import type { CommandContext } from "../registry";

export async function runMigrate(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  // The migrate path is the second positional (args.path); `chant migrate <file>`
  // populates args.path with the file path. Default is current directory.
  if (!args.path || args.path === ".") {
    console.error(formatError({
      message: "chant migrate requires a source file path",
      hint: "chant migrate .github/workflows/ci.yml --output .gitlab-ci.yml",
    }));
    return 1;
  }

  // migrate does not require a chant project context. Load the target
  // lexicon directly by name.
  const toName = args.migrateTo ?? "gitlab";
  let plugins;
  try {
    plugins = await loadPlugins([toName]);
  } catch (err) {
    console.error(formatError({
      message: `Cannot load target lexicon "${toName}": ${err instanceof Error ? err.message : String(err)}`,
      hint: `Install @intentius/chant-lexicon-${toName} or pass --to <other-lexicon>`,
    }));
    return 1;
  }

  const emit = (args.emit as "yaml" | "ts" | undefined) ?? "yaml";
  if (emit !== "yaml" && emit !== "ts") {
    console.error(formatError({ message: `Invalid --emit value: ${emit}. Expected 'yaml' or 'ts'.` }));
    return 1;
  }

  const result = await migrateCommand({
    sourceFile: args.path,
    from: args.migrateFrom ?? "github",
    to: args.migrateTo ?? "gitlab",
    emit,
    strict: args.strict ?? false,
    validate: args.validate ?? false,
    useComposites: args.useComposites ?? false,
    output: args.output,
    reportFile: args.reportFile,
    plugins,
  });

  printMigrateResult(result);
  return result.exitCode;
}
