/**
 * Generation for the e2b lexicon.
 *
 * The lexicon's one kind is written by hand (../resources.ts), so there is no
 * upstream spec to generate types from. What is generated is the static
 * barrel of post-synth checks, `src/lint/post-synth/index.ts`, the same file
 * every lexicon's generate step writes (#409).
 */

import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { moduleSourceDir } from "@intentius/chant/module-source";
import { renderPostSynthBarrelForDir } from "@intentius/chant/codegen/generate-post-synth-barrel";

/** Write the post-synth barrel and return how many checks it lists. */
export function generate(): number {
  const srcDir = dirname(moduleSourceDir(import.meta.url));
  const postSynthDir = join(srcDir, "lint", "post-synth");
  const content = renderPostSynthBarrelForDir(postSynthDir, import.meta.url);
  writeFileSync(join(postSynthDir, "index.ts"), content);
  return (content.match(/^  \w/gm) ?? []).length;
}
