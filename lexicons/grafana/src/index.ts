// Grafana lexicon.

// Plugin and serializer
export { grafanaPlugin } from "./plugin";
export { grafanaSerializer } from "./serializer";

// Datasources
export {
  Datasource,
  DATASOURCE_TYPE,
  ExternalDatasource,
  EXTERNAL_DATASOURCE_TYPE,
  BUILTIN_DATASOURCE_UIDS,
  isDatasourceEntity,
  isExternalDatasource,
  isDatasourceDeclaration,
  type ExternalDatasourceProps,
  type ExternalDatasourceEntity,
  type ExternalDatasourceConstructor,
  type DatasourceProps,
  type DatasourceEntity,
  type DatasourceConstructor,
  type DatasourceRef,
  type DatasourceAccess,
  type KnownDatasourceType,
} from "./datasource";

// Dashboards and provisioning
export {
  Dashboard,
  DashboardProvider,
  DASHBOARD_TYPE,
  DASHBOARD_PROVIDER_TYPE,
  DEFAULT_DASHBOARDS_PATH,
  isDashboardEntity,
  isDashboardProviderEntity,
  type DashboardProps,
  type DashboardEntity,
  type DashboardLinkInput,
  type DashboardProviderProps,
  type DashboardProviderEntity,
} from "./dashboard";

// Grafana-managed alerting
export {
  AlertRuleGroup,
  AlertRule,
  AlertQuery,
  ReduceExpression,
  MathExpression,
  ThresholdExpression,
  ResampleExpression,
  ClassicConditionsExpression,
  SqlExpression,
  ContactPoint,
  NotificationPolicy,
  MuteTiming,
  NotificationTemplate,
  ALERT_RULE_GROUP_TYPE,
  ALERT_RULE_TYPE,
  ALERT_QUERY_TYPE,
  EXPRESSION_TYPE_PREFIX,
  EXPRESSION_DATASOURCE_UID,
  CONTACT_POINT_TYPE,
  NOTIFICATION_POLICY_TYPE,
  MUTE_TIMING_TYPE,
  NOTIFICATION_TEMPLATE_TYPE,
  isAlertRuleGroupEntity,
  isAlertRuleEntity,
  isAlertQueryEntity,
  isExpressionEntity,
  isContactPointEntity,
  isNotificationPolicyEntity,
  isMuteTimingEntity,
  isNotificationTemplateEntity,
  type AlertRuleGroupProps,
  type AlertRuleGroupEntity,
  type AlertRuleProps,
  type AlertRuleEntity,
  type AlertRuleData,
  type AlertRuleNotificationSettings,
  type AlertRuleRecord,
  type AlertQueryProps,
  type AlertQueryEntity,
  type AlertDuration,
  type RelativeTimeRange,
  type ExpressionEntity,
  type ExpressionKind,
  type ReduceExpressionProps,
  type MathExpressionProps,
  type ThresholdExpressionProps,
  type ResampleExpressionProps,
  type ClassicConditionsExpressionProps,
  type SqlExpressionProps,
  type NoDataState,
  type ExecErrState,
  type ContactPointProps,
  type ContactPointEntity,
  type ContactPointReceiver,
  type ContactPointIntegrationType,
  type NotificationPolicyProps,
  type NotificationPolicyEntity,
  type PolicyRoute,
  type ObjectMatcher,
  type MuteTimingProps,
  type MuteTimingEntity,
  type NotificationTemplateProps,
  type NotificationTemplateEntity,
} from "./alerting";
export {
  buildAlerting,
  alertingYaml,
  alertRuleJson,
  alertQueryJson,
  ruleGroupJson,
  contactPointJson,
  notificationPolicyJson,
  muteTimingJson,
  notificationTemplateJson,
  durationSeconds,
  ALERTING_FILE,
  ALERTING_FILE_KEYS,
  DEFAULT_RELATIVE_TIME_RANGE,
  DEFAULT_GROUP_INTERVAL,
  type AlertingFile,
  type AlertingIndex,
  type ProvisionedRuleGroup,
  type ProvisionedAlertRule,
  type ProvisionedAlertQuery,
  type ProvisionedContactPoint,
  type ProvisionedMuteTiming,
  type ProvisionedTemplate,
} from "./alerting-build";
export { CONTACT_POINT_SECRET_SETTINGS } from "./contact-point-secrets";

// Panels and rows, and the extension point for other panel plugins
export {
  TimeSeriesPanel,
  StatPanel,
  GaugePanel,
  TablePanel,
  LogsPanel,
  TracesPanel,
  HeatmapPanel,
  TextPanel,
  BarChartPanel,
  BarGaugePanel,
  PieChartPanel,
  StateTimelinePanel,
  StatusHistoryPanel,
  HistogramPanel,
  NodeGraphPanel,
  XYChartPanel,
  TrendPanel,
  CanvasPanel,
  GeomapPanel,
  FlameGraphPanel,
  AlertListPanel,
  Row,
  definePanel,
  registeredPanels,
  panelDefinitionFor,
  isPanelEntity,
  isRowEntity,
  PANEL_TYPE_PREFIX,
  ROW_TYPE,
  type PanelProps,
  type PanelFieldConfig,
  type PanelLink,
  type PanelDefinition,
  type PanelEntity,
  type PanelClass,
  type RowProps,
  type RowEntity,
} from "./panels";

// Queries, and the extension point for other datasource plugins
export {
  PromQuery,
  TempoQuery,
  LokiQuery,
  defineQuery,
  registeredQueries,
  queryDefinitionFor,
  isQueryEntity,
  QUERY_TYPE_PREFIX,
  type DatasourceInput,
  type QueryModel,
  type QueryProps,
  type QueryDefinition,
  type QueryEntity,
  type QueryClass,
  type PromQueryEntity,
  type TempoQueryEntity,
  type LokiQueryEntity,
} from "./query";

// Variables
export {
  QueryVariable,
  CustomVariable,
  IntervalVariable,
  DatasourceVariable,
  ConstantVariable,
  TextboxVariable,
  isVariableEntity,
  isDatasourceVariable,
  isBuiltinVariable,
  VARIABLE_NAME,
  VARIABLE_TYPE_PREFIX,
  type VariableKind,
  type VariableHide,
  type VariableEntity,
  type VariableDatasource,
  type DatasourceVariableEntity,
  type QueryVariableProps,
  type CustomVariableProps,
  type IntervalVariableProps,
  type DatasourceVariableProps,
  type ConstantVariableProps,
  type TextboxVariableProps,
} from "./variables";

// The generated schema types and their pin
export * as schema from "./schema";
export { DASHBOARD_SCHEMA_VERSION } from "./schema";
export {
  GRAFANA_SCHEMA_PIN,
  SCHEMA_NAMES,
  IMPORT_ONLY_SCHEMA_NAMES,
  VENDORED_SCHEMA_NAMES,
  type GrafanaSchemaPin,
  type SchemaName,
  type ImportOnlySchemaName,
  type VendoredSchemaName,
} from "./pin";
// Hand-written options for the built-in panels with no schema
export type { AlertListOptions, AlertListSortOrder, AlertListStateFilter, FlameGraphOptions } from "./panel-options";

// Plain-data API: render, check and detect without a build
export {
  buildGrafana,
  grafanaFiles,
  renderDashboard,
  dashboardJson,
  dashboardUid,
  panelsJson,
  targetJson,
  variableModel,
  datasourceRef,
  provisionedDatasource,
  externalDatasourceRecord,
  provisionedProvider,
  datasourcesYaml,
  dashboardProvidersYaml,
  GRID_COLUMNS,
  DATASOURCES_FILE,
  DASHBOARD_PROVIDERS_FILE,
  DASHBOARDS_DIR,
  type BuiltGrafana,
  type BuiltDashboard,
  type GrafanaIndex,
  type ProvisionedDatasource,
  type ExternalDatasourceRecord,
  type ProvisionedProvider,
  type DashboardJson,
  type PanelJson,
  type RowPanelJson,
  type VariableModel,
  type DataSourceRef,
} from "./build";
export {
  validateGrafanaOutput,
  issuesFor,
  knownDatasourcesOf,
  variableReferences,
  type GrafanaIssue,
  type GrafanaIssueCode,
  type GrafanaArtifacts,
  type DashboardDoc,
} from "./validate-output";
export {
  datasourceUses,
  resolveDatasourceRef,
  knownDatasources,
  type DatasourceUse,
  type ResolvedDatasource,
  type KnownDatasource,
  type DatasourceRefJson,
} from "./datasource-refs";
export { validateDashboardSchema, validateExpressionSchema, type SchemaProblem } from "./schema-validate";
export { looksLikeDashboard, looksLikeDatasourceProvisioning, looksLikeDashboardProvisioning, looksLikeAlertingProvisioning } from "./detect";
export { slugUid, isValidUid, UID_PATTERN, type DeepPartial, type PropsOf } from "./util";

// Composites: dashboards built from a spanmetrics connector, an Slo and the GenAI preset, and an Slo's burn-rate alerts as Grafana rules
export {
  RedDashboard,
  redQueries,
  RED_DEFAULT_SPAN_KINDS,
  SloDashboard,
  sloQueries,
  AgentDashboard,
  agentQueries,
  type RedDashboardProps,
  type RedDashboardMembers,
  type RedDashboardInstance,
  type SpanKind,
  type SloDashboardProps,
  type SloDashboardMembers,
  type SloDashboardInstance,
  type AgentDashboardProps,
  type AgentDashboardMembers,
  type AgentDashboardInstance,
  type DashboardOptions,
  SloAlertRules,
  sloAlertQueries,
  type SloAlertRulesProps,
  type SloAlertRulesMembers,
  type SloAlertRulesInstance,
} from "./composites";

// Config namespace (#2946): `grafana.profiles.<env>` in chant.config.ts, the
// Grafana each environment is observed in and exported from.
export { grafanaConfigSchema, resolveGrafanaTarget } from "./config";
export type { GrafanaConfig, GrafanaProfile } from "./config";

// Ownership (#2946): chant's marker on a dashboard.grafana.app resource.
export {
  GRAFANA_OWNERSHIP_KEYS,
  DEFAULT_PROVIDER_NAME,
  grafanaOwnershipLabels,
  dashboardOwnership,
} from "./ownership";

// The HTTP client observe and export share, for the API applier (#2948).
export { GrafanaClient, GrafanaApiError, grafanaHttp, namespaceOf, statusVerdict } from "./api/client";
export type { GrafanaAuth, GrafanaHttp, GrafanaResponse, GrafanaTarget, StatusVerdict } from "./api/client";
export { bindGrafana, classifyGrafanaFailure, GrafanaBindingError } from "./api/bind";
