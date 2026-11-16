/**
 * The floors of the prow lexicon's parts: for each part a product may
 * feature-detect on, the first release of `@intentius/chant-lexicon-prow`
 * that has it. chant core's floor table (`@intentius/chant/floor-table`)
 * lists them beside core's, with this package's name.
 */
import { NEXT_RELEASE } from "@intentius/chant/release-floors";

/** The first prow lexicon release: `Presubmit`, `Postsubmit`, `Periodic` and `JobConfig`, `emitJobConfig` for plain job data, `chant import` of a job config, and the PROW rules (#5169). */
export const PROW_LEXICON_FLOOR = NEXT_RELEASE;
