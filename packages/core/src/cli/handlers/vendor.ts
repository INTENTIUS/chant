import { resolve } from "node:path";
import { vendorPull, vendorCheck } from "../commands/vendor";
import { formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

/**
 * `chant vendor [pull|check]` — pull pinned, checksummed patterns into the repo,
 * or check vendored targets against their recorded pin. Defaults to `pull`.
 *
 * The manifest (`vendor.json`) lives in the current directory.
 */
export async function runVendor(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  // `chant vendor` → pull; `chant vendor pull|check [name]`.
  const sub = args.path === "." ? "pull" : args.path;
  const manifestDir = resolve(".");

  if (sub === "pull") {
    try {
      const result = await vendorPull(manifestDir, args.extraPositional);
      if (!result.success) {
        console.error(formatError({ message: result.output }));
        return 1;
      }
      console.log(result.output);
      console.error(formatSuccess(`Vendored ${result.pulled.length} artifact(s)`));
      return 0;
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
  }

  if (sub === "check") {
    try {
      const result = vendorCheck(manifestDir);
      console.log(result.output);
      if (!result.drift) {
        console.error(formatSuccess("All vendored artifacts match their pin"));
        return 0;
      }
      // Drift is allowed (you may edit vendored files); fail only in CI so a
      // pipeline catches unrecorded changes, warn locally.
      if (process.env.CI) {
        console.error(formatError({ message: "Vendored content drifted from the manifest pin" }));
        return 1;
      }
      console.error(formatWarning({ message: "Vendored content drifted from the manifest pin (run `chant vendor pull` to re-pin)" }));
      return 0;
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
  }

  console.error(formatError({
    message: `Unknown vendor subcommand: ${sub}`,
    hint: "Available: chant vendor pull [name], chant vendor check",
  }));
  return 1;
}
