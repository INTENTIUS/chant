// Drift source — event source #2. Runs `chant lifecycle diff --live` and starts
// a triage workflow for each drifted resource, so out-of-band cluster changes go
// through the same triage as external alerts. This is the runtime counterpart of
// a WatchOp (which schedules the same diff on a cron).
//
//   npm run drift            # real: diff the env, triage any drift
//   npm run drift -- --demo  # inject a sample drift to exercise the pipeline
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startTriage } from "./triage-client.js";
import { alertFromDrift, type DriftEntry } from "./parse.js";

const execFileAsync = promisify(execFile);
const env = process.env.ALERT_TRIAGE_ENV ?? "local";

async function detectDrift(): Promise<DriftEntry[]> {
  if (process.argv.includes("--demo")) {
    // Labeled demo input — a sample drift to show the pipeline without needing a
    // real out-of-band change. The real path below runs an actual live diff.
    return [{ name: "alert-webhook", type: "Deployment", category: "drifted" }];
  }
  const { stdout } = await execFileAsync(
    "chant",
    ["lifecycle", "diff", env, "--live", "--json"],
    { cwd: new URL("..", import.meta.url).pathname },
  );
  const report = JSON.parse(stdout) as { drifted?: DriftEntry[] };
  return report.drifted ?? [];
}

async function main(): Promise<void> {
  const drifted = await detectDrift().catch((err) => {
    console.error(`drift check failed (no snapshot/baseline yet?): ${err}`);
    return [] as DriftEntry[];
  });
  if (drifted.length === 0) {
    console.log("no drift — nothing to triage");
    return;
  }
  for (const entry of drifted) {
    const id = await startTriage(alertFromDrift(entry));
    console.log(`drift on ${entry.name} → started triage ${id}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
