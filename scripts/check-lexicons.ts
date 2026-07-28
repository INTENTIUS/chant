#!/usr/bin/env tsx
/**
 * chant #1067 — run the lexicon completeness contract for every lexicon and
 * actually gate on it. `chant dev check-lexicon <dir>` existed before this
 * issue but ran nowhere — not in CI, not via `just` — so even its original
 * 29 existence/count checks were advisory in practice. This script is the
 * thing that makes it a contract: loop every `lexicons/*` directory, run
 * the full tier-1 check set (including the #1067 additions — intrinsic
 * foldability validation and "every shipped example builds"), and fail the
 * process if any *untracked* tier-1 check fails anywhere.
 *
 * Turning this on for the first time immediately surfaced real, pre-existing
 * gaps this contract was never run against before — some are architecture
 * mismatches (forgejo/temporal don't fit the tier-1 bar's assumptions that
 * every lexicon has its own lint rules, LSP support, and example projects;
 * neither is a "cloud resource" lexicon in the sense the bar was written
 * for), others are real defects the new example-build check caught for the
 * first time (github's composites use a lazy `require()` that doesn't run
 * under ESM; helm's per-composite demo files collide on generic destructured
 * names like `chart`/`values`; fly's only example is still the unfilled
 * `chant init` scaffold). None of these are what #1067 set out to fix, and
 * guessing at real fixes for them here (invented lint rules, invented Fly
 * Machines properties) would be worse than leaving them visible.
 *
 * KNOWN_FAILURES is exactly that: visible, not hidden. It works the same
 * way `EXPECTED_FOLD` in examples/fold-differential.test.ts already does for
 * fold coverage — a precise, named, must-stay-current fixture of today's
 * state. A failure NOT listed here is a regression and fails the gate. A
 * listed failure that starts passing prints an INFO line asking for the
 * entry to be deleted — not a hard failure, since over-fitting to exact
 * detail text would be brittle, but visible so the list doesn't silently
 * rot into tracking fixed problems forever.
 *
 * Also runs each lexicon's own `tsconfig.build.json` build (`npm run build
 * -w @intentius/chant-lexicon-<name>`) — the other named-and-decided gap in
 * #1067: core's own gating (`just build`) never covers a lexicon's separate
 * tsc build, so a change can pass locally and only fail in CI's "Generate
 * lexicon artifacts" step. Unlike the tier-1 checks above, a tsc failure
 * here is never something to track-and-allow — it always fails the gate.
 *
 * chant #1072 resolved the architecture-mismatch question above (option 1:
 * build both up to the bar, not relax it for them). Forgejo now has a
 * manifest, a plugin.test.ts, docs, and an example project, and its lint
 * rules/LSP completions/hover wrap or delegate to github's rather than
 * forking them — see lexicons/forgejo/src/lint/rules/delegate-to-github.ts
 * and lexicons/forgejo/src/lsp/. Temporal now has a real source-level lint
 * rule (TMP020, alongside its existing TMP00x post-synth checks), LSP
 * completions/hover over its own 4-resource catalog, and an example project
 * — see lexicons/temporal/src/lint/rules/use-activity-profiles.ts and
 * lexicons/temporal/src/lsp/. Neither has an entry in KNOWN_FAILURES below
 * anymore.
 */

import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { checkLexicon } from "@intentius/chant/cli/commands/check-lexicon";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lexiconsDir = join(repoRoot, "lexicons");

/**
 * lexicon name -> tier-1 check name -> tracking issue/reason.
 * Every entry here MUST reference a filed, open issue.
 */
const KNOWN_FAILURES: Record<string, Record<string, string>> = {};

let untrackedFailures = 0;
let trackedFailures = 0;
let staleTrackedEntries = 0;
let tscFailures = 0;

const lexiconNames = readdirSync(lexiconsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

for (const name of lexiconNames) {
  const dir = join(lexiconsDir, name);

  if (existsSync(join(dir, "tsconfig.build.json"))) {
    try {
      execFileSync("npm", ["run", "build", "-w", `@intentius/chant-lexicon-${name}`], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } catch (err) {
      tscFailures++;
      untrackedFailures++;
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      const output = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join("\n");
      console.log(`\n${name} — tsc build FAILED (tsconfig.build.json)`);
      console.log(output.split("\n").map((l) => `  ${l}`).join("\n"));
      continue;
    }
  }

  const result = await checkLexicon(dir);
  const tier1 = result.items.filter((i) => i.tier === 1);
  const failing = tier1.filter((i) => !i.pass);
  const known = KNOWN_FAILURES[name] ?? {};

  console.log(`\n${name} — ${tier1.length - failing.length}/${tier1.length} tier-1 checks passing`);

  for (const item of failing) {
    const reason = known[item.name];
    if (reason) {
      trackedFailures++;
      console.log(`  KNOWN  ${item.name} — ${reason}`);
    } else {
      untrackedFailures++;
      console.log(`  FAIL   ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
    }
  }

  for (const checkName of Object.keys(known)) {
    const item = tier1.find((i) => i.name === checkName);
    if (item?.pass) {
      staleTrackedEntries++;
      console.log(`  INFO   "${checkName}" now passes — remove its KNOWN_FAILURES entry in scripts/check-lexicons.ts`);
    }
  }
}

console.log("");
if (staleTrackedEntries > 0) {
  console.log(`${staleTrackedEntries} tracked failure(s) now pass — clean up KNOWN_FAILURES (informational, not a gate failure).`);
}
if (trackedFailures > 0) {
  console.log(`${trackedFailures} known, tracked tier-1 failure(s) — see KNOWN_FAILURES in this script for issue references.`);
}

if (tscFailures > 0) {
  console.log(`${tscFailures} lexicon(s) failed their own tsc build — never trackable, always fixed.`);
}

if (untrackedFailures > 0) {
  console.log(`${untrackedFailures} untracked failure(s) (tier-1 checks and/or tsc builds). Fix them, or add a reasoned KNOWN_FAILURES entry referencing a filed issue.`);
  process.exit(1);
}

console.log("No untracked tier-1 failures.");
