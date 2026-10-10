/**
 * Which table engines the rebuild reads as merged (#3674): the verification
 * (`./verify.ts`) and the plan's hand-off note (`../plan/rebuild-handoff.ts`).
 */

/**
 * The MergeTree engines that collapse rows sharing a sorting key when parts
 * merge, as `system.tables.engine` names them, replicated or shared too. A
 * count of such a table depends on which parts have merged; under `FINAL` it
 * does not.
 */
const COLLAPSING_ENGINE = /^(?:Replicated|Shared)?(?:Summing|Replacing|Aggregating|Collapsing|VersionedCollapsing|Coalescing|Graphite)MergeTree$/;

/** Whether an engine collapses rows that share a sorting key (#3674). */
export const collapsesRows = (engine: string | undefined): boolean => COLLAPSING_ENGINE.test(engine ?? "");
