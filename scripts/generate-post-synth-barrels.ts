#!/usr/bin/env tsx
/**
 * Regenerate the static post-synth check barrels for every lexicon (#409).
 *
 * Writes `lexicons/<lex>/src/lint/post-synth/index.ts` — a committed, static,
 * importable list of that lexicon's post-synth checks, replacing the runtime
 * fs-glob + tsx require() loader on the audit path. Run via `npm run generate`.
 */

import { readdirSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { renderPostSynthBarrelForDir } from "../packages/core/src/codegen/generate-post-synth-barrel";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lexiconsDir = join(repoRoot, "lexicons");

let written = 0;
for (const lexicon of readdirSync(lexiconsDir).sort()) {
  const postSynthDir = join(lexiconsDir, lexicon, "src", "lint", "post-synth");
  if (!existsSync(postSynthDir)) continue;
  const content = renderPostSynthBarrelForDir(postSynthDir, import.meta.url);
  const out = join(postSynthDir, "index.ts");
  writeFileSync(out, content);
  const count = (content.match(/^  \w/gm) ?? []).length;
  console.error(`  ${lexicon}: ${count} checks -> ${out.replace(repoRoot + "/", "")}`);
  written++;
}
console.error(`Generated ${written} post-synth barrels.`);
