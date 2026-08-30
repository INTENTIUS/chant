import { carveAdvise, carveJson, formatCarveReport } from "../commands/carve";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant carve advise --from <terraform-dir | cdk.out> [--json] [--report <path>]`
 *
 * Read-only. Reuses `--from` (shared with migrate/import) for the source dir,
 * and works out which source it is by looking at the directory (#1056) rather
 * than adding a second flag. Loads no chant project and no lexicon plugins —
 * pure analysis of a foreign tree.
 */
export async function runCarveAdvise(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  const result = await carveAdvise({
    from: args.migrateFrom, // `--from <terraform-dir | cdk.out>`
    statePath: args.statePath, // `--state <tfstate>`
    reportFile: args.reportFile, // `--report <path>`
  });

  if (!result.ok) {
    console.error(formatError({
      message: result.error ?? "carve advise failed",
      hint: "chant carve advise --from ./path/to/terraform   (or ./cdk.out)",
    }));
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(carveJson(result), null, 2));
  } else {
    console.log(formatCarveReport(result));
  }
  return 0;
}

/** Fallback for `chant carve` with no/unknown subcommand. */
export async function runCarveUnknown(_ctx: CommandContext): Promise<number> {
  console.error(formatError({
    message: "Unknown carve subcommand",
    hint: "chant carve advise --from <terraform-dir | cdk.out>   (read-only peelability report)",
  }));
  return 1;
}
