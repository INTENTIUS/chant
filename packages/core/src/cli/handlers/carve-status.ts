import { carveStatus, carveStatusJson, formatCarveStatus } from "../commands/carve-status";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant carve status [--from <dir>] [--json]` — the read-only status read
 * over a tree of carve manifests (#2038). Walks from `--from` (default: cwd),
 * reports every manifest's target, stage (planned/emitted/bridged/applied)
 * and path. No plugins, no project, no cloud call.
 */
export async function runCarveStatus(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  const result = carveStatus({ from: args.migrateFrom /* `--from <dir>` */ });

  if (!result.ok) {
    console.error(formatError({
      message: result.error ?? "carve status failed",
      hint: "chant carve status --from ./tf --json",
    }));
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(carveStatusJson(result), null, 2));
  } else {
    console.log(formatCarveStatus(result));
  }
  return 0;
}
