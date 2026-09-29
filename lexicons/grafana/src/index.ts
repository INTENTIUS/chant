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
export { GRAFANA_SCHEMA_PIN, SCHEMA_NAMES, type GrafanaSchemaPin, type SchemaName } from "./pin";

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
  customVariableOptions,
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
export { validateDashboardSchema, type SchemaProblem } from "./schema-validate";
export { looksLikeDashboard, looksLikeDatasourceProvisioning, looksLikeDashboardProvisioning } from "./detect";
export { slugUid, isValidUid, UID_PATTERN, type DeepPartial } from "./util";

// Composites: dashboards built from a spanmetrics connector, an Slo and the GenAI preset
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
} from "./composites";
