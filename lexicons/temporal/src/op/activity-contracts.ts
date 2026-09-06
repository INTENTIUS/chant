/**
 * Re-export shim — the activity contracts moved to core alongside the
 * activities they describe (`@intentius/chant/op/activities/activity-contracts`,
 * chant #2114). Kept so this lexicon's post-synth rules and op IR resolve
 * unchanged until #2116 deletes them.
 */
export * from "@intentius/chant/op/activities/activity-contracts";
