/**
 * CLI for the emulator-freshness check (#808 T2). Fetches the latest mudflaps /
 * spritzer releases, compares to the pinned tags, prints a report, and — when
 * run in CI — writes `behind` + a Markdown `body` to `$GITHUB_OUTPUT` so the
 * weekly workflow can open/refresh a single "N releases behind" notice issue.
 *
 * Advisory only: exits 0 whether or not a pin is behind (the bump is a human
 * decision per the #808 policy). A hard failure (network/API) exits 1.
 */

import { appendFileSync } from "node:fs";
import { checkFreshness, formatResult, type FreshnessResult } from "./emulator-freshness";

function issueBody(behind: FreshnessResult[]): string {
  const rows = behind.map((r) => `- **${r.name}** — pinned \`${r.pinned}\`, latest \`${r.latest}\``).join("\n");
  return [
    "The pinned Fly emulator image(s) are behind their latest upstream release:",
    "",
    rows,
    "",
    "The tag lives in `lexicons/fly/src/op/activities/emulator-images.ts` (single source).",
    "",
    "Per the #808 bump policy this is **advisory** — move the pin only when a consuming",
    "test needs the newer emulator (a fidelity fix the fly activities exercise), not on",
    "every release. Close this issue once reviewed or bumped.",
  ].join("\n");
}

async function main(): Promise<void> {
  const results = await checkFreshness();
  for (const r of results) console.error(formatResult(r));

  const behind = results.filter((r) => r.behind);
  console.log(JSON.stringify({ behind: behind.length > 0, results }, null, 2));

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `behind=${behind.length > 0}\n`);
    if (behind.length > 0) {
      // Multiline output via the GITHUB_OUTPUT heredoc form.
      appendFileSync(out, `body<<FRESHNESS_EOF\n${issueBody(behind)}\nFRESHNESS_EOF\n`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
