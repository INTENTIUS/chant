/**
 * Advisory watch on the dogwood pin (#1688).
 *
 * Reads `dogwood-policy/dogwood`'s current `main` through the GitHub API — no
 * clone, two requests — and reports, per pinned surface, whether the blob still
 * matches what #1657 verified. The comparison and the reporting live in
 * `dogwood-freshness.ts`; this is the entry point that wires the real pin, the
 * real network, and the CI plumbing to them.
 *
 * Exit codes, following `check-emulator-freshness.ts`: 0 whenever the check
 * itself ran, whether or not anything moved, and 1 only when it could not run at
 * all. A moved surface is information — per #808 the pin moves when a consuming
 * test needs the newer upstream, not because upstream moved — so nothing here
 * ever gates a build.
 *
 * Human lines go to stderr and JSON to stdout, so a caller can redirect the JSON
 * into a report artifact and still watch the run.
 */

import { appendFileSync } from "node:fs";
import { DOGWOOD_UPSTREAM } from "../lexicons/cedar/src/dogwood/upstream";
import {
  buildReport,
  fetchUpstreamState,
  formatReport,
  githubTransport,
  markdownReport,
} from "./dogwood-freshness";

const BRANCH = "main";

async function main(): Promise<void> {
  const state = await fetchUpstreamState(DOGWOOD_UPSTREAM, BRANCH, githubTransport());
  const report = buildReport(DOGWOOD_UPSTREAM, BRANCH, state);

  for (const line of formatReport(report)) console.error(line);
  console.log(JSON.stringify(report, null, 2));

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdownReport(report)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `surfaces-moved=${report.surfacesMoved}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `revision-moved=${report.revisionMoved}\n`);
  }
}

main().catch((error: unknown) => {
  // Only a check that could not run reaches here: a network failure, a rate
  // limit, a renamed repository. Say so plainly — the absence of a report is
  // not the same as "nothing moved".
  console.error(`dogwood freshness check could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
