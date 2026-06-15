/**
 * Build the runtime-E2E fixture workflow (./src) and write the generated
 * `.forgejo/workflows/ci.yml` into the output directory passed as argv[2].
 *
 * Kept out of ./src so discovery doesn't import this driver. Run by
 * test/forgejo-runtime-e2e.sh before handing the workflow to a Forgejo runner.
 */

import { build } from "@intentius/chant/build";
import { getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { forgejoSerializer } from "@intentius/chant-lexicon-forgejo/serializer";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: tsx build.ts <output-dir>");
  process.exit(2);
}

const result = await build(join(here, "src"), [forgejoSerializer]);
if (result.errors.length > 0) {
  console.error("build failed:");
  for (const e of result.errors) console.error("  " + (e.message ?? String(e)));
  process.exit(1);
}

// The forgejo serializer is registered under the "github" lexicon (it
// serializes the reused github entities).
const out = result.outputs.get("github");
const yaml = out ? getPrimaryOutput(out) : "";
if (!yaml) {
  console.error("no Forgejo workflow produced");
  process.exit(1);
}

const dir = join(outDir, ".forgejo", "workflows");
mkdirSync(dir, { recursive: true });
const dest = join(dir, "ci.yml");
writeFileSync(dest, yaml);
console.log(`wrote ${dest}`);
