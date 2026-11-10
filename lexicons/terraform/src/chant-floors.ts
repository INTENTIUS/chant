/**
 * The chant floors of the terraform lexicon's parts (#4916): for each part a
 * product may feature-detect on, the first chant release whose lexicon has
 * it. Lexicons release with chant at the same version, so each is a chant
 * version, and chant core's floor table (`@intentius/chant/floor-table`)
 * lists them beside core's, which `chant dev dead-guards` reads.
 *
 * Only this file is read for the table: the `_FLOOR` constants elsewhere in
 * the lexicon name versions of other tools (`NEXUS_HOSTED_FLOOR` in
 * ./registry/targets/nexus.ts is a Nexus version). The entries that serve a
 * part re-export its floor by name, so the table names those subpaths too.
 *
 * This file imports nothing, so an entry that must stay light (./module-catalog)
 * can re-export from it.
 */

/**
 * The first chant whose terraform lexicon has `moduleConsumers`, the scan of
 * every registry module call a root makes, with `readRegistryCatalog` and
 * `deprecatedPins` beside it on `./registry` (#4599).
 */
export const MODULE_CONSUMERS_FLOOR = "0.124.55";

/**
 * The first chant whose terraform lexicon has `usedSources`, every module
 * source and provider address a root uses, with `moduleSourceForms`,
 * `providerAddressForms` and `lockedProviders` on `./registry` (#3924).
 */
export const USED_SOURCES_FLOOR = "0.124.55";

/** The first chant whose terraform lexicon has `./module-catalog`, the known-module catalog TF047 reads (#4560). */
export const MODULE_CATALOG_FLOOR = "0.124.55";
