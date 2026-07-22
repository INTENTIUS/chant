import { carveEmit, formatCarveEmit } from "../commands/carve-emit";
import { liveImportFromPlugins } from "../commands/import";
import { loadPlugins } from "../plugins";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant carve emit --from <tf-dir> --select <address> (--state <tfstate> | --env <env>)`
 *
 * Adopts the selected Terraform resource into typed chant source. `--state`
 * adopts offline from the tfstate (no plugins); `--env` adopts via the live
 * cloud import path, for which the target lexicon is loaded lazily here — so a
 * state-only carve never pays the plugin-load cost.
 */
export async function runCarveEmit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  // Load plugins only for the live path; the offline --state path needs none.
  let plugins = ctx.plugins;
  if (!args.statePath && args.env) {
    try {
      plugins = await loadPlugins(["aws"]);
    } catch {
      // fall through with whatever ctx provided; carveEmit surfaces a clear error
    }
  }

  const result = await carveEmit(
    {
      from: args.migrateFrom, // `--from <terraform-dir>`
      select: args.selectAddress, // `--select <tf-address>`
      env: args.env,
      liveName: args.liveName, // `--live-name <cfn-logical-id>`
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
