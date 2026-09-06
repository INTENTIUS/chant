/**
 * Shared support for the OPS* Op-model post-synth checks (#2122, epic #2114
 * sub-issue 6) — OPS012 (`./ops012-activity-contract.ts`), OPS013
 * (`./ops013-step-output-ref.ts`) and OPS014
 * (`./ops014-converge-rule-refusals.ts`), ported here from the temporal
 * lexicon's TMP012/TMP013/TMP014.
 *
 * Op-entity recognition is core's own `isOpEntity` (`../../../op/resource.ts`,
 * #2118) — re-exported here so every OPS* check imports it from one place.
 */
export { isOpEntity } from "../../../op/resource";
