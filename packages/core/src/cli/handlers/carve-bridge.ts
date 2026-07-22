import { carveBridge, formatCarveBridge } from "../commands/carve-bridge";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant carve bridge --from <tf-dir> --select <address> [--output <dir>] [--apply-rewrites]`
 *
 * Read-only by default: writes proposed survivor patches + a runbook to an
 * output dir. `--apply-rewrites` edits the surviving `.tf` in place. Loads no
 * lexicon plugins — pure Terraform-side analysis.
 */
export async function runCarveBridge(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  const result = await carveBridge({
    from: args.migrateFrom, // `--from <terraform-dir>`
    select: args.selectAddress, // `--select <tf-address>`
    statePath: args.statePath,
    output: args.output,
    applyRewrites: args.applyRewrites,
  });

  if (!result.ok) {
    console.error(formatError({
      message: result.error ?? "carve bridge failed",
      hint: "chant carve bridge --from ./tf --select aws_s3_bucket.assets",
    }));
    return 1;
  }

  console.log(formatCarveBridge(result));
  return 0;
}
