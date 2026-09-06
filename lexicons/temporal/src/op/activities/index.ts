/**
 * Re-export shim — the base activities live in core now
 * (`@intentius/chant/op/activities`, chant #2114). Nothing about `shellCmd`,
 * `chantBuild` or `convergeTick` was ever Temporal's; they were only hosted
 * here. Kept as a shim so `@intentius/chant-lexicon-temporal/op/activities`
 * still resolves until #2116 deletes this lexicon.
 */
export * from "@intentius/chant/op/activities";
