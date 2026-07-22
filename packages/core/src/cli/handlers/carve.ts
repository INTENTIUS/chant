import { carveAdvise, carveJson, formatCarveReport } from "../commands/carve";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant carve advise --from <terraform-dir> [--json] [--report <path>]`
 *
 * Read-only. Reuses `--from` (shared with migrate/import) for the estate dir.
 * Loads no chant project and no lexicon plugins — pure analysis of a foreign
 * Terraform tree.
 */
export async function runCarveAdvise(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  const result = await carveAdvise({
    from: args.migrateFrom, // `--from <terraform-dir>`
    reportFile: args.reportFile, // `--report <path>`
  });

  if (!result.ok) {
    console.error(formatError({
      message: result.error ?? "carve advise failed",
      hint: "chant carve advise --from ./path/to/terraform",
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
    hint: "chant carve advise --from <terraform-dir>   (read-only peelability report)",
  }));
  return 1;
}
