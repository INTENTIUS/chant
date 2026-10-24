import { lexiconOfSide, migrateCommand, printMigrateResult } from "../commands/migrate";
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

  // A side is a lexicon, or a lexicon and a dialect: `sql/clickhouse` (#4399).
  const toName = args.migrateTo ?? "gitlab";
  const fromName = args.migrateFrom ?? "github";

  // The sql pair writes declarations, so ts is its default; yaml is the gitlab pair's.
  const emit = (args.emit as "yaml" | "ts" | "sql" | undefined) ?? (lexiconOfSide(toName) === "sql" ? "ts" : "yaml");
  if (emit !== "yaml" && emit !== "ts" && emit !== "sql") {
    console.error(formatError({ message: `Invalid --emit value: ${emit}. Expected 'yaml', 'ts' or 'sql'.` }));
    return 1;
  }

  if (emit === "sql" && lexiconOfSide(toName) !== "sql") {
    console.error(formatError({ message: `--emit sql writes DDL, and ${toName} is not a sql target`, hint: "use --emit yaml or --emit ts" }));
    return 1;
  }

  // migrate does not require a chant project context. Load the target
  // lexicon directly by name.
  let plugins;
  try {
    plugins = await loadPlugins([lexiconOfSide(toName)]);
  } catch (err) {
    console.error(formatError({
      message: `Cannot load target lexicon "${toName}": ${err instanceof Error ? err.message : String(err)}`,
      hint: `Install @intentius/chant-lexicon-${lexiconOfSide(toName)} or pass --to <other-lexicon>`,
    }));
    return 1;
  }

  const result = await migrateCommand({
    sourceFile: args.path,
    from: fromName,
    to: toName,
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
