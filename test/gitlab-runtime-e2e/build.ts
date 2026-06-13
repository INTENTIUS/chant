/**
 * Build the runtime-E2E fixture pipeline (./src) and write the generated
 * .gitlab-ci.yml into the output directory passed as argv[2].
 *
 * Kept out of ./src so discovery doesn't import this driver. Run by
 * test/gitlab-runtime-e2e.sh before handing the YAML to gitlab-ci-local.
 */

import { build } from "@intentius/chant/build";
import { getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { gitlabSerializer } from "@intentius/chant-lexicon-gitlab/serializer";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: tsx build.ts <output-dir>");
  process.exit(2);
}

const result = await build(join(here, "src"), [gitlabSerializer]);
if (result.errors.length > 0) {
  console.error("build failed:");
  for (const e of result.errors) console.error("  " + (e.message ?? String(e)));
  process.exit(1);
}

const out = result.outputs.get("gitlab");
const yaml = out ? getPrimaryOutput(out) : "";
if (!yaml) {
  console.error("no GitLab YAML produced");
  process.exit(1);
}

const dest = join(outDir, ".gitlab-ci.yml");
writeFileSync(dest, yaml);
console.log(`wrote ${dest}`);
