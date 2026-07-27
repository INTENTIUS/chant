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
const KNOWN_FAILURES: Record<string, Record<string, string>> = {
  forgejo: {
    "At least 1 lint rule in src/lint/rules/":
      "#1072 — forgejo is a thin github-dialect (serializer + `uses:` resolver) with no lint rules of its own — delegates to github's.",
    "src/lsp/completions.ts exists":
      "#1072 — forgejo has no LSP completions provider of its own — delegates to github's.",
    "src/lsp/hover.ts exists":
      "#1072 — forgejo has no LSP hover provider of its own — delegates to github's.",
    "dist/manifest.json exists":
      "#1072 — forgejo's prepack is `npm run build` only (no generate/bundle step) — it never produces dist/manifest.json.",
    "dist/manifest.json declares a chantVersion":
      "#1072 — same root cause as \"dist/manifest.json exists\" above — no manifest, so no chantVersion.",
    "At least 1 example in examples/":
      "#1072 — forgejo has no example projects of its own.",
    "plugin.test.ts exists":
      "#1072 — forgejo has no plugin.test.ts.",
    "At least 1 .mdx doc page":
      "#1072 — forgejo has no docs/ site of its own.",
  },
  github: {
    "Registered intrinsics are exported by the package":
      "#1069 — plugin.ts registers an \"expression\" intrinsic; src/index.ts exports the `Expression` class (capitalized) and helper functions, but nothing literally named `expression`.",
    "Registered intrinsics' isTag matches how they're authored":
      "#1069 — same root cause as the export check above — unresolvable, so unverifiable.",
  },
  helm: {
    "Every shipped example builds":
      "#1070 — composites-basic/composites-infrastructure/composites-production each bundle multiple independent per-composite demo files that destructure the same generic names (`chart`, `values`, `deployment`, `service`, ...) from different HelmXxx(...) composite calls — fine as isolated per-file demos (and covered that way in their own .test.ts), but a \"Duplicate export name\" the moment the whole src/ directory builds as one project. helm-render-external-secrets produces no output; stateful-service hits a \"Cannot serialize AttrRef ... logical name not set\" error.",
  },
  temporal: {
    "At least 1 lint rule in src/lint/rules/":
      "#1072 — temporal's TMP00x checks are post-synth checks (src/lint/post-synth/), not pre-synth lint rules — it has no src/lint/rules/ directory.",
    "src/lsp/completions.ts exists":
      "#1072 — temporal has no LSP completions provider.",
    "src/lsp/hover.ts exists":
      "#1072 — temporal has no LSP hover provider.",
    "At least 1 example in examples/":
      "#1072 — temporal has no example projects — it's consumed via composites in other examples (e.g. temporal-crdb-deploy) rather than shipping its own.",
  },
};

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
