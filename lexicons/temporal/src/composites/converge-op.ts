/**
 * Re-export shim (#2120). ConvergeOp moved to `packages/core/src/op/composites/`
 * when the cadence became `OpConfig.schedule` rather than a `TemporalSchedule`
 * resource; this file keeps `@intentius/chant-lexicon-temporal`'s export
 * surface until #2116 removes it. A project that runs Temporal pairs the Op
 * with a `TemporalSchedule` of its own — see `lexicons/cedar/src/dogwood/replay-op.ts`.
 */

export { ConvergeOp, type ConvergeOpConfig, type ConvergeOpResources, type ConvergeDial } from "@intentius/chant/op";
