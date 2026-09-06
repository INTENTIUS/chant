/**
 * Shared post-synth fixture loader.
 *
 * KICS lays its own query fixtures out as `positive.tf`/`negative.tf` pairs
 * beside the query that tests them (survey, #2107): every query is
 * externally auditable because a rule and its evidence live in the same
 * directory. This lexicon adopts that layout: `fixtures/<id>/positive.tf`
 * triggers the check, `fixtures/<id>/negative.tf` does not, and a rule with
 * more than one triggering condition adds `positive-<case>.tf` beside them.
 *
 * KICS itself scans a whole fixture directory in one pass and tells its
 * fixtures apart by the file each finding came from. That doesn't transfer
 * here: TF001 (and most post-synth checks with per-root state, not
 * per-resource) fire once per *root*, deduplicated by root name, so parsing
 * `positive.tf` and `negative.tf` together as one root would let whichever
 * file's terraform block is read first decide the outcome for both, silently
 * discarding the other. `loadFixture` therefore reads exactly the one named
 * file and parses it alone, through the same `blocksToEntities` pass
 * `parseTerraformRootDir` wraps for a real root directory, so sibling
 * fixtures never mix into one build.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../../hcl/parse";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Parse `fixtures/<checkId>/<name>.tf` into a {@link PostSynthContext} whose
 * `entities` are exactly what a real root module of that one file would
 * produce. `root` (the entity key prefix and the `TerraformEntity.props.root`
 * value) defaults to `checkId`; pass a distinct value to load two fixtures
 * into one context under different root names.
 *
 * Three lines per fixture in a test:
 * ```ts
 * const diags = tf001.check(await loadFixture("TF001", "positive"));
 * expect(diags).toHaveLength(1);
 * ```
 */
export async function loadFixture(
  checkId: string,
  name: string,
  root: string = checkId,
): Promise<PostSynthContext> {
  const file = `${name}.tf`;
  const source = readFileSync(join(FIXTURES_DIR, checkId, file), "utf-8");
  const entities = await blocksToEntities([{ name: file, source }], root);
  return {
    outputs: new Map(),
    entities,
    buildResult: {
      outputs: new Map(),
      entities,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}
