/**
 * The floors of the terraform lexicon's parts (#4916): for each part a
 * product may feature-detect on, the first release of
 * `@intentius/chant-lexicon-terraform` that has it. Each package has its own
 * version (#5138), so these are versions of the terraform lexicon, not of
 * chant core. chant core's floor table (`@intentius/chant/floor-table`)
 * lists them beside core's with the package each belongs to, and `chant dev
 * dead-guards` reads them against a product's pin on the lexicon.
 *
 * Only this file is read for the table: the `_FLOOR` constants elsewhere in
 * the lexicon name versions of other tools (`NEXUS_HOSTED_FLOOR` in
 * ./registry/targets/nexus.ts is a Nexus version). The entries that serve a
 * part re-export its floor by name, so the table names those subpaths too.
 *
 * This file imports only NEXT_RELEASE, so an entry that must stay light
 * (./module-catalog) can re-export from it.
 */
import { NEXT_RELEASE } from "@intentius/chant/release-floors";

/**
 * The first terraform lexicon release that has `moduleConsumers`, the scan of
 * every registry module call a root makes, with `readRegistryCatalog` and
 * `deprecatedPins` beside it on `./registry` (#4599).
 */
export const MODULE_CONSUMERS_FLOOR = "0.124.55";

/**
 * The first terraform lexicon release that has `usedSources`, every module
 * source and provider address a root uses, with `moduleSourceForms`,
 * `providerAddressForms` and `lockedProviders` on `./registry` (#3924).
 */
export const USED_SOURCES_FLOOR = "0.124.55";

/** The first terraform lexicon release that has `./module-catalog`, the known-module catalog TF047 reads (#4560). */
export const MODULE_CATALOG_FLOOR = "0.124.55";

/**
 * The first terraform lexicon release whose `classifyDisruption` classifies a
 * planned update from the plan's actions (in place, replace, destroy), with
 * `terraformDisruptionQueries` for a plan in hand, and whose `healthTargets`
 * reads a root's covered resources through the aws, azure and gcp health
 * reads with ids from its state (#5338).
 */
export const TERRAFORM_HEALTH_DISRUPTION_FLOOR = NEXT_RELEASE;

/**
 * The first terraform lexicon release that puts `facts.ownershipRows` on a
 * choudoufu live root's nodes (#5402): `live-plan`'s `bound[].source`,
 * `identity_values`, omission and adoption rows, `live-graph`'s
 * `meta.engineGraph.gaps`, and with `CHANT_TERRAFORM_LIVE_LISTING=1`,
 * `live-ls`'s `gaps[]` and `listed`. It needs `@intentius/chant` at
 * `ENGINE_OWNERSHIP_ROWS_FLOOR` or later.
 */
export const TERRAFORM_OWNERSHIP_ROWS_FLOOR = NEXT_RELEASE;
