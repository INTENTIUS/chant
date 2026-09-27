/**
 * Prometheus lexicon composites: declarations that expand to rule groups.
 */

export {
  Slo,
  sloMetrics,
  sloPropsProblem,
  sliExprProblem,
  DEFAULT_BURN_RATES,
  SLO_WINDOW_PLACEHOLDER,
} from "./slo";
export type {
  SloProps,
  SloSli,
  SloAlerting,
  SloAlertTier,
  BurnRateWindow,
  SloMembers,
  SloInstance,
  SloMetrics,
  SloBurnRate,
} from "./slo";
