/**
 * How far behind every lexicon's pinned emulator image is (#1345).
 *
 * This was `lexicons/fly/src/emulator-freshness-cli.ts`, covering fly's two
 * pins. The other three emulators ran `floci/*:latest`, so there was nothing to
 * be behind — an image could change underneath a passing local suite with no
 * record in the repo of what moved. Now every emulator declares a pinned tag
 * and its upstream repo on its `EmulatorSpec`, and this enumerates the lexicons
 * rather than naming them, so a new emulator is covered by declaring
 * `upstream`.
 *
 * Advisory only: exits 0 whether or not a pin is behind. The bump is a human
 * decision per the #808 policy — the tag moves when a consuming test needs the
 * newer emulator, not because a release happened. A hard failure (network, API)
 * exits 1. In CI it writes `behind` and a Markdown `body` to `$GITHUB_OUTPUT`
 * so the weekly workflow can open or refresh a single notice issue.
 */

import { appendFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFreshness, formatResult, unpinned, type FreshnessResult } from "../packages/core/src/op/emulator-freshness";
import { emulatorsOf, type EmulatorSpec } from "../packages/core/src/op/emulator-lifecycle";
import { loadLexiconFromDir } from "../packages/core/src/cli/commands/check-lexicon-plugin";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every emulator spec every lexicon in the repo declares. */
async function allSpecs(): Promise<Array<{ lexicon: string; spec: EmulatorSpec }>> {
  const lexiconsDir = join(repoRoot, "lexicons");
  const found: Array<{ lexicon: string; spec: EmulatorSpec }> = [];
  for (const entry of readdirSync(lexiconsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const { plugin } = await loadLexiconFromDir(join(lexiconsDir, entry.name));
    for (const capability of emulatorsOf(plugin?.emulator)) {
      found.push({ lexicon: entry.name, spec: capability.spec });
    }
  }
  return found;
}

function issueBody(behind: FreshnessResult[]): string {
  const rows = behind.map((r) => `- **${r.name}** — pinned \`${r.pinned}\`, latest \`${r.latest}\``).join("\n");
  return [
    "The pinned emulator image(s) are behind their latest upstream release:",
    "",
    rows,
    "",
    "Each tag lives on its lexicon's `EmulatorSpec` (`image`), beside the `upstream`",
    "repo this check reads.",
    "",
    "Per the #808 bump policy this is **advisory** — move a pin only when a consuming",
    "test needs the newer emulator, not on every release. Close this issue once",
    "reviewed or bumped.",
  ].join("\n");
}

async function main(): Promise<void> {
  const declared = await allSpecs();
  const specs = declared.map((d) => d.spec);

  // An emulator on a floating tag is not "current" — it is unpinnable, and
  // saying nothing about it would reproduce exactly what this check exists to
  // catch.
  for (const spec of unpinned(specs)) {
    console.error(`⚠ ${spec.name}: image ${spec.image} is not pinned to a version`);
  }

  const results = await checkFreshness(specs);
  for (const r of results) console.error(formatResult(r));

  const behind = results.filter((r) => r.behind);
  console.log(JSON.stringify({ behind: behind.length > 0, results }, null, 2));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `behind=${behind.length > 0}\n`);
    if (behind.length > 0) {
      appendFileSync(process.env.GITHUB_OUTPUT, `body<<EOF\n${issueBody(behind)}\nEOF\n`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
