import { carveApply, formatCarveApply } from "../commands/carve-apply";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant carve apply --from <tf-dir> --select <address> --env <env> [--stack <name>] [--write]`
 *
 * Resolves the ownership marker + graduation runbook. BYOL-honest: no cloud
 * calls. `--write` saves the graduation doc. No lexicon plugins needed.
 */
export async function runCarveApply(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  const result = await carveApply({
    from: args.migrateFrom, // `--from <terraform-dir>`
    select: args.selectAddress, // `--select <tf-address>`
    env: args.env,
    stack: args.carveStack,
    statePath: args.statePath,
    output: args.output,
    write: args.write,
    writeSource: args.writeSource,
  });

  if (!result.ok) {
    console.error(formatError({
      message: result.error ?? "carve apply failed",
      hint: "chant carve apply --from ./tf --select aws_s3_bucket.assets --env prod",
    }));
    return 1;
  }

  console.log(formatCarveApply(result));
  return 0;
}
