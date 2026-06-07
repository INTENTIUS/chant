// Drift source — event source #2. Runs `chant lifecycle plan --json` and starts
// a triage workflow for each non-noop change-set entry, so out-of-band cluster
// changes go through the same triage as external alerts. The runtime counterpart
// of a WatchOp (which schedules the same check on a cron).
//
//   npm run drift            # real: plan the env, triage any drift
//   npm run drift -- --demo  # inject a sample drift to exercise the pipeline
//
// NOTE: the real path needs the env deployed + a snapshot, and `chant lifecycle
// plan` currently builds the project dir with lexicon auto-detection, which does
// not yet handle this example's mixed layout (chant src/ alongside app/ +
// activities/). Until that lands (#252), `--demo` is the reliable demonstration;
// the real path degrades to "no drift" rather than failing.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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
  // `lifecycle plan --json` emits a typed ChangeSet ({ env, entries: [...] }).
  // (`lifecycle diff` has no --json.) Every non-noop entry is something the live
  // system and the declared source disagree on — triage each.
  const { stdout } = await execFileAsync(
    "chant",
    ["lifecycle", "plan", env, "k8s", "--json"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)) },
  );
  const plan = JSON.parse(stdout) as {
    entries?: Array<{ name: string; type?: string; action: string }>;
  };
  return (plan.entries ?? [])
    .filter((e) => e.action !== "noop")
    .map((e) => ({ name: e.name, type: e.type, category: e.action }));
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
