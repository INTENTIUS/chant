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
  DatasourceProvisioning,
  DATASOURCE_PROVISIONING_TYPE,
  isDatasourceProvisioningEntity,
  type DatasourceProvisioningProps,
  type DatasourceProvisioningEntity,
  type DeletedDatasource,
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

// Typed datasource settings (jsonData, secureJsonData keys) per plugin
export {
  JSONDATA_LINKS,
  TRACING_DATASOURCE_TYPES,
  TRACE_TO_LOGS_DATASOURCE_TYPES,
  TRACE_TO_METRICS_DATASOURCE_TYPES,
  type JsonDataLink,
  type LinkedDatasource,
  type TracingDatasourceType,
  type TraceToLogsDatasourceType,
  type TraceToMetricsDatasourceType,
  type TypedDatasourceType,
  type DatasourceJsonData,
  type DatasourceSecureJsonData,
  type DatasourceJsonDataTypes,
  type DatasourceSecureJsonKeys,
  type CommonJsonData,
  type HttpJsonData,
  type HttpSecureJsonKey,
  type PrometheusJsonData,
  type ExemplarTraceIdDestination,
  type LokiJsonData,
  type DerivedFieldConfig,
  type TempoJsonData,
  type TraceToLogsTag,
  type TraceToLogsOptions,
  type TraceToLogsOptionsV2,
  type TraceToMetricsOptions,
  type TraceToProfilesOptions,
  type ElasticsearchJsonData,
  type ElasticsearchDataLink,
  type ElasticsearchSecureJsonKey,
  type AwsAuthJsonData,
  type AwsAuthSecureJsonKey,
  type CloudWatchJsonData,
  type CloudWatchLogGroup,
  type CloudWatchSecureJsonKey,
  type AzureCloudName,
  type AzureCredentials,
  type AzureMonitorJsonData,
  type AzureMonitorSecureJsonKey,
  type GoogleAuthJsonData,
  type GoogleAuthSecureJsonKey,
  type CloudMonitoringJsonData,
  type CloudMonitoringSecureJsonKey,
  type BigQueryJsonData,
  type BigQuerySecureJsonKey,
  type PyroscopeJsonData,
  type PyroscopeSecureJsonKey,
  type SqlJsonData,
  type PostgresJsonData,
  type PostgresSecureJsonKey,
  type MySQLJsonData,
  type MySQLSecureJsonKey,
  type MSSQLJsonData,
  type MSSQLSecureJsonKey,
} from "./datasource-settings";

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
  type DashboardEntityProps,
  type DashboardProviderEntityProps,
} from "./dashboard";

// Folders and annotations
export { Folder, FOLDER_TYPE, isFolderEntity, folderLevels, type FolderProps, type FolderEntity } from "./folder";
export { annotationJson, ANNOTATION_REF_ID, type AnnotationInput } from "./annotations";

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
  ElasticsearchQuery,
  CloudWatchQuery,
  AzureMonitorQuery,
  CloudMonitoringQuery,
  BigQueryQuery,
  PyroscopeQuery,
  PostgresQuery,
  MySQLQuery,
  MSSQLQuery,
  defineQuery,
  registeredQueries,
  queryDefinitionFor,
  isQueryEntity,
  QUERY_TYPE_PREFIX,
  type DatasourceInput,
  type QueryModel,
  type Loosen,
  type MergedModel,
  type QueryProps,
  type QueryDefinition,
  type QueryEntity,
  type QueryClass,
  type PromQueryEntity,
  type TempoQueryEntity,
  type LokiQueryEntity,
  type ElasticsearchQueryEntity,
  type CloudWatchQueryEntity,
  type AzureMonitorQueryEntity,
  type CloudMonitoringQueryEntity,
  type BigQueryQueryEntity,
  type PyroscopeQueryEntity,
  type PostgresQueryEntity,
  type MySQLQueryEntity,
  type MSSQLQueryEntity,
} from "./query";

// Hand-written query models for datasources with no schema
export type {
  SqlQueryModel,
  SqlBuilderQuery,
  SqlQueryFormat,
  SqlExpressionType,
  SqlProperty,
  SqlFunctionExpression,
  SqlFunctionParameterExpression,
  SqlGroupByExpression,
  SqlPropertyExpression,
} from "./query-models";

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
  AdhocVariable,
  GroupByVariable,
  SwitchVariable,
  MULTI_VALUE_KINDS,
  type AdhocVariableProps,
  type GroupByVariableProps,
  type SwitchVariableProps,
  type AdhocFilter,
  type VariableKeyOption,
  type VariableQueryObject,
  type PrometheusVariableQuery,
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

// Panel transformations, typed per transformer (Grafana v13.2.2)
export {
  transformation,
  customTransformation,
  TRANSFORMATION_IDS,
  type Transformation,
  type KnownTransformation,
  type CustomTransformation,
  type TransformationCommon,
  type TransformationId,
  type TransformationOptionsById,
  type ReducerId,
} from "./transformations";

// Plain-data API: render and detect without a build
export {
  buildGrafana,
  grafanaFiles,
  renderDashboard,
  dashboardJson,
  dashboardUid,
  panelsJson,
  targetJson,
  variableModel,
  customVariableOptions,
  datasourceRef,
  provisionedDatasource,
  externalDatasourceRecord,
  provisionedProvider,
  datasourcesYaml,
  datasourceFileSettings,
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
  type DatasourceFileSettings,
  type DashboardJson,
  type PanelJson,
  type RowPanelJson,
  type VariableModel,
  type DataSourceRef,
} from "./build";
// The checks as plain functions (validateGrafanaOutput, validateDashboardSchema)
// are on the `@intentius/chant-lexicon-grafana/validation` subpath (#2958), so
// declaring dashboards does not load them.
export {
  datasourceUses,
  variableReferences,
  resolveDatasourceRef,
  knownDatasources,
  type DatasourceUse,
  type ResolvedDatasource,
  type KnownDatasource,
  type DatasourceRefJson,
} from "./datasource-refs";
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
  agentRuleQueries,
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

// The API applier (#2948): the typed Op step, and the pieces an embedding
// caller composes (the activity itself is `./op/activities`).
export { grafanaApply } from "./op/builders";
export { applyGrafana, planFromDashboards, GRAFANA_APPLY_KINDS } from "./api/apply";
export type { GrafanaApplyPlan, GrafanaApplyOutcome, DashboardPlan, BuiltDashboardInput } from "./api/apply";
export { folderUidFor, foldersForDashboards, resolveFolders, liveFolderPath, type FolderPlan, type ResolvedFolders } from "./api/folders";

// The Grafana RBAC actions a service account needs to observe, apply and prune.
export { GrafanaActions, grafanaActionsFor, type GrafanaAccessLevel } from "./actions/index";
