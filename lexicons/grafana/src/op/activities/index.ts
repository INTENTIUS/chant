/**
 * Grafana Op activities, resolved by the core activity registry when a
 * project's `chant.config.ts` lists the `grafana` lexicon. Contributes the
 * API applier (`grafanaApply`, #2948) and its envelope projection
 * (`toApplyResult`), which core's apply activity looks up by name.
 */
export { grafanaApply, toApplyResult, readBuiltDashboards, resolveMarker } from "./grafana-apply";
export type { GrafanaApplyArgs, GrafanaApplyDeps, GrafanaApplyOutcome } from "./grafana-apply";
