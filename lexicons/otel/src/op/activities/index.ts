/**
 * otel Op activities (#3369), resolved by the core activity registry when a
 * project's `chant.config.ts` lists the `otel` lexicon. Every function this
 * module exports is an activity, bound by its export name, so the helpers
 * behind them stay in their own files.
 *
 * - `otelcolValidate`, `otelcolComponents`: the collector binary's own
 *   checks over a config file.
 * - `collectorHealthObserve`: running collectors as the resources of a
 *   `ConvergeOp({ observe })`.
 * - `collectorAudit`: the lexicon's pins against upstream releases, the
 *   step of `CollectorAuditOp`.
 */
export { otelcolValidate, otelcolComponents } from "./otelcol";
export type { OtelcolValidateArgs, OtelcolValidateResult, OtelcolComponentsArgs, OtelcolComponentsResult, MissingComponent } from "./otelcol";
export { collectorHealthObserve } from "./collector-health";
export type { CollectorHealthObserveArgs, CollectorHealthObserveResult, ObservedCollector, CollectorEndpointKind } from "./collector-health";
export { collectorAudit } from "./collector-audit";
export type { CollectorAuditArgs, CollectorAuditResult, CollectorAuditFinding, CollectorAuditFindingKind, CollectorAuditMode } from "./collector-audit";
