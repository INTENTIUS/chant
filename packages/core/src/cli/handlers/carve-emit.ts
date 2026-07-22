import { carveEmit, formatCarveEmit } from "../commands/carve-emit";
import { liveImportFromPlugins } from "../commands/import";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant carve emit --from <tf-dir> --select <address> --env <env> [--output <dir>] [--report <path>]`
 *
 * Adopts the selected Terraform resource into typed chant source (cloud→code
 * live import) and reports its boundary. Requires the target lexicon's plugins
 * (loaded from the project) for the live export.
 */
export async function runCarveEmit(ctx: CommandContext): Promise<number> {
  const { args, plugins } = ctx;

  const result = await carveEmit(
    {
      from: args.migrateFrom, // `--from <terraform-dir>`
      select: args.selectAddress, // `--select <tf-address>`
      env: args.env,
      statePath: args.statePath,
      output: args.output,
      reportFile: args.reportFile,
    },
    { plugins, liveImport: liveImportFromPlugins },
  );

  if (!result.ok) {
    console.error(formatError({
      message: result.error ?? "carve emit failed",
      hint: "chant carve emit --from ./tf --select aws_s3_bucket.assets --env prod",
    }));
    return 1;
  }

  console.log(formatCarveEmit(result));
  return 0;
}
