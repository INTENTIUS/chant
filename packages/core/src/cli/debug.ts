/**
 * Debug logger — outputs to stderr when CHANT_DEBUG env var or --verbose/-v flag is set.
 */
export function debug(...args: unknown[]): void {
  if (process.env.CHANT_DEBUG || process.argv.includes("--verbose") || process.argv.includes("-v")) {
    console.error("[chant:debug]", ...args);
  }
}
