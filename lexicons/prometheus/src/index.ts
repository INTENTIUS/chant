// Prometheus lexicon.

// Plugin and serializer
export { prometheusPlugin } from "./plugin";
export { prometheusSerializer, ALERTMANAGER_FILE, PROMETHEUS_FILE } from "./serializer";

// Rule groups
export {
  RuleGroup,
  RULE_GROUP_TYPE,
  isRuleGroup,
  ruleGroupConfig,
  ruleConfig,
  type RuleGroupProps,
  type RuleGroupEntity,
  type Rule,
  type RecordingRule,
  type AlertingRule,
} from "./rules";

// Alertmanager
export {
  Route,
  Receiver,
  InhibitRule,
  TimeInterval,
  AlertmanagerSettings,
  ROUTE_TYPE,
  RECEIVER_TYPE,
  INHIBIT_RULE_TYPE,
  TIME_INTERVAL_TYPE,
  SETTINGS_TYPE,
  isRoute,
  isReceiver,
  isInhibitRule,
  isTimeInterval,
  isAlertmanagerSettings,
  isAlertmanagerEntity,
  type RouteProps,
  type RouteEntity,
  type ReceiverProps,
  type ReceiverEntity,
  type ReceiverRef,
  type InhibitRuleProps,
  type InhibitRuleEntity,
  type TimeIntervalProps,
  type TimeIntervalEntity,
  type TimeIntervalRef,
  type AlertmanagerSettingsProps,
  type AlertmanagerSettingsEntity,
} from "./alertmanager";

// prometheus.yml
export {
  PrometheusConfig,
  ScrapeConfig,
  PROMETHEUS_CONFIG_TYPE,
  SCRAPE_CONFIG_TYPE,
  isPrometheusConfig,
  isScrapeConfig,
  isPrometheusConfigEntity,
  type PrometheusConfigProps,
  type PrometheusConfigEntity,
  type ScrapeConfigProps,
  type ScrapeConfigEntity,
} from "./prometheus-config";

// The plain-data model, building, YAML and checks
export * from "./model";
export {
  buildRuleFile,
  buildAlertmanagerConfig,
  buildPrometheusConfig,
  ruleFileYaml,
  alertmanagerYaml,
  prometheusConfigYaml,
  emitYaml,
  type BuiltRuleFile,
  type BuiltAlertmanager,
  type BuiltPrometheusConfig,
} from "./build";
export { isValidDuration, durationMs, formatDuration } from "./duration";
export { parseMatchers, matcherMatches, matcher, type Matcher, type MatchOp, type ParsedMatchers } from "./matchers";
export { checkPromql, PROMQL_GRAMMAR, type PromqlCheck } from "./promql";
export {
  validateRuleFile,
  validateRunbookUrls,
  validateAlertmanagerConfig,
  validateSeverityRouting,
  alertSeverities,
  type PrometheusIssue,
  type PrometheusIssueCode,
} from "./validate-config";
export { PROMETHEUS_PIN } from "./pin";

// promtool and amtool, when installed
export { promtoolCheckRules, promtoolCheckConfig, promtoolTestRules, amtoolCheckConfig, hasTool, type ToolResult } from "./tools";

// Composites
export {
  Slo,
  sloMetrics,
  sloPropsProblem,
  sliExprProblem,
  DEFAULT_BURN_RATES,
  SLO_WINDOW_PLACEHOLDER,
  type SloProps,
  type SloSli,
  type SloAlerting,
  type SloAlertTier,
  type BurnRateWindow,
  type SloMembers,
  type SloInstance,
  type SloMetrics,
  type SloBurnRate,
  GenAiRules,
  genAiRuleMetrics,
  type GenAiRulesProps,
  type GenAiRulesMembers,
  type GenAiRulesInstance,
  type GenAiRuleMetrics,
  type GenAiPrice,
  type GenAiAlerting,
  type GenAiAlertOptions,
  type GenAiRatioAlert,
  type GenAiLatencyAlert,
  type GenAiBudget,
  type GenAiAlertInfo,
  type GenAiQuantileSeries,
} from "./composites";
