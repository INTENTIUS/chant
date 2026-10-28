/**
 * The body of `chant e2e safe-run` (chant#4587, C1): run one command through
 * {@link SafeRun}, so a bash driver gets the same environment and the same
 * scan the TypeScript harness uses.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SafeRun } from "./safe-run";

/** Exit code when the scan finds a real cloud answering: nothing may be recorded. */
export const EXIT_REAL_CLOUD = 3;
/** Exit code for a usage error or an environment the wrapper refuses. */
export const EXIT_REFUSED = 2;

export interface SafeRunCommandInput {
  command: string[];
  /** Directories scanned after the run, beside the command's output. */
  scan?: string[];
  /** Where the log and the empty config dirs go; a fresh temp dir by default. */
  scratch?: string;
  /** The environment the wrapper scrubs; process.env by default. */
  base?: Record<string, string | undefined>;
  /** Pass the command's output through to this process's stdout and stderr (default true). */
  echo?: boolean;
}

export async function runSafeRunCommand(i: SafeRunCommandInput): Promise<number> {
  const scratch = i.scratch ?? mkdtempSync(join(tmpdir(), "chant-e2e-safe-run-"));
  let safe: SafeRun;
  try {
    safe = new SafeRun({ scratch, scan: (i.scan ?? []).map((d) => resolve(d)), echo: i.echo ?? true }, i.base);
  } catch (err) {
    console.error(`e2e-safe-run: refused: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_REFUSED;
  }
  let code: number;
  try {
    code = await safe.run(i.command);
  } catch (err) {
    console.error(`e2e-safe-run: could not run ${i.command[0]}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_REFUSED;
  }
  const verdict = safe.scan();
  if (verdict.verdict === "CLEAN") {
    console.log("CLEAN");
    console.error(`e2e-safe-run: log ${safe.logFile}`);
    return code;
  }
  console.error("REAL-CLOUD CALL: the output shows a public cloud rejecting a credential, so a call left this machine. This run is not recorded.");
  for (const h of verdict.hits) console.error(`  ${h}`);
  console.error(`e2e-safe-run: log ${safe.logFile}`);
  return EXIT_REAL_CLOUD;
}
