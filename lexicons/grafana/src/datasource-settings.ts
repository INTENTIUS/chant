/**
 * Typed `jsonData` and `secureJsonData` for the datasource plugins this
 * lexicon has query classes for.
 *
 * Grafana defines datasource settings in each plugin's TypeScript (and reads
 * them in its Go backend), with no CUE kind, so foundation-sdk publishes no
 * schema for them. The types here are written by hand from the source of the
 * plugin versions bundled with grafana/grafana:13.2.2 (the image's
 * `data/plugins-bundled/<id>`, read through each plugin's source map), from
 * Grafana's own tree at v13.2.2 for the plugins still in it (CloudWatch,
 * Azure Monitor, `@grafana/sql`, `@grafana/o11y-ds-frontend`), and from
 * grafana-plugin-sdk-go v0.296.2 (the version Grafana 13.2.2 builds with)
 * for the HTTP client settings every HTTP-based plugin shares. Each type
 * cites where it was read.
 *
 * Every key is optional: a provisioning file may leave anything out and
 * Grafana fills in its defaults. Keys a plugin still reads from older
 * versions are kept and marked deprecated. `secureJsonData` is typed by its
 * keys only; the values are strings, which GRAF002 wants as `$__env{NAME}`
 * or `$__file{/path}`.
 *
 * A field that names another datasource takes a `LinkedDatasource`: a
 * declared or external datasource of a plugin type Grafana's picker offers
 * there (written as its uid), or the uid as a string for anything else.
 */

import type { DatasourceEntity, ExternalDatasourceEntity } from "./datasource";
import type { TraceqlFilter } from "./schema/tempo.gen";

/**
 * Another datasource, named inside a datasource's settings: a declared or
 * external datasource of one of the plugin types `T` (the build writes its
 * uid), or a uid string, which is not checked.
 */
export type LinkedDatasource<T extends string = string> = DatasourceEntity<T> | ExternalDatasourceEntity<T> | string;

/**
 * The tracing datasources Grafana's picker offers for exemplar and derived
 * field links: the bundled plugins whose plugin.json sets `tracing: true`
 * in grafana/grafana:13.2.2.
 */
export const TRACING_DATASOURCE_TYPES = ["tempo", "jaeger", "zipkin"] as const;
export type TracingDatasourceType = (typeof TRACING_DATASOURCE_TYPES)[number];

/**
 * The logs datasources the traces-to-logs picker offers: `supportedDataSourceTypes`,
 * packages/grafana-o11y-ds-frontend/src/TraceToLogs/TraceToLogsSettings.tsx:80-88 at v13.2.2.
 */
export const TRACE_TO_LOGS_DATASOURCE_TYPES = [
  "loki",
  "elasticsearch",
  "grafana-splunk-datasource",
  "grafana-opensearch-datasource",
  "grafana-falconlogscale-datasource",
  "googlecloud-logging-datasource",
  "victoriametrics-logs-datasource",
] as const;
export type TraceToLogsDatasourceType = (typeof TRACE_TO_LOGS_DATASOURCE_TYPES)[number];

/** The metrics datasources the traces-to-metrics picker offers, TraceToMetricsSettings.tsx:38-41 at v13.2.2. */
export const TRACE_TO_METRICS_DATASOURCE_TYPES = ["prometheus", "victoriametrics-metrics-datasource"] as const;
export type TraceToMetricsDatasourceType = (typeof TRACE_TO_METRICS_DATASOURCE_TYPES)[number];

// ── shared by every plugin ─────────────────────────────────────────

/**
 * Settings every datasource may carry: `DataSourceJsonData`,
 * packages/grafana-data/src/types/datasource.ts:755-763 at v13.2.2.
 */
export interface CommonJsonData {
  authType?: string;
  defaultRegion?: string;
  profile?: string;
  /** Show this datasource's alert rules in Grafana Alerting. */
  manageAlerts?: boolean;
  allowAsRecordingRulesTarget?: boolean;
  /** The Alertmanager datasource this one's alerts go to. */
  alertmanagerUid?: LinkedDatasource<"alertmanager">;
  disableGrafanaCache?: boolean;
}

/**
 * The HTTP client settings every HTTP-based plugin shares, read by
 * grafana-plugin-sdk-go v0.296.2: `parseHTTPSettings` in
 * backend/http_settings.go:108-305, the secure socks proxy in
 * backend/proxy/secure_socks_proxy.go:245 and backend/common.go:336-383.
 * `keepCookies`, `timeout` and `oauthPassThru` are also what @grafana/plugin-ui's
 * `AdvancedHttpSettings` and `Auth` config components write.
 */
export interface HttpJsonData extends CommonJsonData {
  /** Request timeout, in seconds. */
  timeout?: number;
  dialTimeout?: number;
  httpKeepAlive?: number;
  httpTLSHandshakeTimeout?: number;
  httpExpectContinueTimeout?: number;
  httpMaxConnsPerHost?: number;
  httpMaxIdleConns?: number;
  httpMaxIdleConnsPerHost?: number;
  httpIdleConnTimeout?: number;
  /** Present a client certificate (`tlsClientCert`, `tlsClientKey`). */
  tlsAuth?: boolean;
  /** Verify the server against `tlsCACert`. */
  tlsAuthWithCACert?: boolean;
  tlsSkipVerify?: boolean;
  /** The TLS server name to verify. */
  serverName?: string;
  /** Sign requests with AWS SigV4. */
  sigV4Auth?: boolean;
  sigV4AuthType?: string;
  sigV4Region?: string;
  sigV4AssumeRoleArn?: string;
  sigV4ExternalId?: string;
  sigV4Profile?: string;
  /** Forward the user's OAuth identity to the datasource. */
  oauthPassThru?: boolean;
  /** Cookies to forward to the datasource, by name. */
  keepCookies?: string[];
  enableSecureSocksProxy?: boolean;
  secureSocksProxyUsername?: string;
  /** Secure socks proxy keep-alive, in seconds. */
  keepAlive?: number;
  /** Custom headers: `httpHeaderName1` names the header whose value is `secureJsonData.httpHeaderValue1`. */
  [header: `httpHeaderName${number}`]: string | undefined;
}

/** `secureJsonData` keys the HTTP client reads (same sources as `HttpJsonData`); `password` is the datasource user's (backend/common.go:142-146). */
export type HttpSecureJsonKey =
  | "basicAuthPassword"
  | "password"
  | "tlsCACert"
  | "tlsClientCert"
  | "tlsClientKey"
  | "sigV4AccessKey"
  | "sigV4SecretKey"
  | "sigV4SessionToken"
  | "secureSocksProxyPassword"
  | `httpHeaderValue${number}`;

// ── trace links (Tempo, and the trace views of other plugins) ──────

/** `TraceToLogsTag`, packages/grafana-o11y-ds-frontend/src/TraceToLogs/TraceToLogsSettings.tsx:18-21 at v13.2.2. */
export interface TraceToLogsTag {
  key: string;
  value?: string;
}

/**
 * Trace to logs: `TraceToLogsOptionsV2`, TraceToLogsSettings.tsx:36-45.
 * `customQuery` is required there; the editor treats a missing one as false.
 */
export interface TraceToLogsOptionsV2 {
  datasourceUid?: LinkedDatasource<TraceToLogsDatasourceType>;
  tags?: TraceToLogsTag[];
  spanStartTimeShift?: string;
  spanEndTimeShift?: string;
  filterByTraceID?: boolean;
  filterBySpanID?: boolean;
  /** The logs query, when `customQuery` is set. */
  query?: string;
  customQuery?: boolean;
}

/**
 * @deprecated The pre-9.x trace-to-logs settings, `TraceToLogsOptions` (TraceToLogsSettings.tsx:24-34).
 * Grafana reads them when `tracesToLogsV2` is absent and rewrites them as `tracesToLogsV2` when the settings are saved.
 */
export interface TraceToLogsOptions {
  datasourceUid?: LinkedDatasource<TraceToLogsDatasourceType>;
  tags?: string[];
  mappedTags?: TraceToLogsTag[];
  mapTagNamesEnabled?: boolean;
  spanStartTimeShift?: string;
  spanEndTimeShift?: string;
  filterByTraceID?: boolean;
  filterBySpanID?: boolean;
  lokiSearch?: boolean;
}

/**
 * Trace to metrics: `TraceToMetricsOptions` and `TraceToMetricQuery`,
 * packages/grafana-o11y-ds-frontend/src/TraceToMetrics/TraceToMetricsSettings.tsx:18-29
 * at v13.2.2; the picker offers `prometheus` and `victoriametrics-metrics-datasource` (lines 38-41).
 */
export interface TraceToMetricsOptions {
  datasourceUid?: LinkedDatasource<TraceToMetricsDatasourceType>;
  tags?: Array<{ key: string; value?: string }>;
  queries?: Array<{ name?: string; query?: string }>;
  spanStartTimeShift?: string;
  spanEndTimeShift?: string;
}

/**
 * Trace to profiles: `TraceToProfilesOptions`,
 * packages/grafana-o11y-ds-frontend/src/TraceToProfiles/TraceToProfilesSettings.tsx:21-27
 * at v13.2.2; the picker offers only `grafana-pyroscope-datasource` (line 36).
 */
export interface TraceToProfilesOptions {
  datasourceUid?: LinkedDatasource<"grafana-pyroscope-datasource">;
  tags?: Array<{ key: string; value?: string }>;
  query?: string;
  profileTypeId?: string;
  customQuery?: boolean;
}

// ── Prometheus ──────────────────────────────────────────────────────

/**
 * Where an exemplar's trace id links: `ExemplarTraceIdDestination`,
 * packages/grafana-prometheus/src/types.ts:58-63 in prometheus 13.1.7
 * (bundled with grafana/grafana:13.2.2). Either `datasourceUid` (an
 * internal link to a tracing datasource) or `url`.
 */
export interface ExemplarTraceIdDestination {
  /** The exemplar label that holds the trace id, e.g. `trace_id`. */
  name: string;
  datasourceUid?: LinkedDatasource<TracingDatasourceType>;
  url?: string;
  urlDisplayLabel?: string;
}

/**
 * Prometheus settings: `PromOptions`, packages/grafana-prometheus/src/types.ts:35-56
 * in prometheus 13.1.7, bundled with grafana/grafana:13.2.2, with the
 * enums at types.ts:21-33 and querybuilder/shared/types.ts:88-91.
 */
export interface PrometheusJsonData extends HttpJsonData {
  /** The scrape interval, the lower bound for `$__interval`, e.g. `15s`. */
  timeInterval?: string;
  queryTimeout?: string;
  httpMethod?: "POST" | "GET";
  /** Extra query string parameters, `a=b&c=d`. */
  customQueryParameters?: string;
  disableMetricsLookup?: boolean;
  exemplarTraceIdDestinations?: ExemplarTraceIdDestination[];
  prometheusType?: "Prometheus" | "Cortex" | "Mimir" | "Thanos";
  prometheusVersion?: string;
  cacheLevel?: "Low" | "Medium" | "High" | "None";
  defaultEditor?: "code" | "builder";
  incrementalQuerying?: boolean;
  incrementalQueryOverlapWindow?: string;
  disableRecordingRules?: boolean;
  seriesEndpoint?: boolean;
  seriesLimit?: number;
  maxSamplesProcessedWarningThreshold?: number;
  maxSamplesProcessedErrorThreshold?: number;
  queryStatsEnabled?: boolean;
}

// ── Loki ────────────────────────────────────────────────────────────

/**
 * A derived field: a link from a log line (by regex) or a label to a URL or
 * a tracing datasource. `DerivedFieldConfig`, types.ts:57-65 in loki 13.2.0
 * (bundled with grafana/grafana:13.2.2); the datasource picker is limited to
 * tracing datasources (configuration/DerivedField.tsx:192).
 */
export interface DerivedFieldConfig {
  /** The regex (or, with `matcherType: "label"`, the label name) the value is taken from. */
  matcherRegex: string;
  name: string;
  url?: string;
  urlDisplayLabel?: string;
  datasourceUid?: LinkedDatasource<TracingDatasourceType>;
  matcherType?: "label" | "regex";
  targetBlank?: boolean;
}

/**
 * Loki settings: `LokiOptions`, types.ts:37-42 in loki 13.2.0, bundled with
 * grafana/grafana:13.2.2. `keepCookies` is in `HttpJsonData`.
 */
export interface LokiJsonData extends HttpJsonData {
  /** The default line limit, as a string (`"1000"`). */
  maxLines?: string;
  derivedFields?: DerivedFieldConfig[];
  /** @deprecated Read by Loki's alerting settings before `alertmanagerUid`. */
  alertmanager?: string;
}

// ── Tempo ───────────────────────────────────────────────────────────

/**
 * Tempo settings: `TempoJsonData`, types.ts:6-29 in tempo 13.1.5 (bundled
 * with grafana/grafana:13.2.2), with the trace-link settings of
 * `@grafana/o11y-ds-frontend` its config editor writes (configuration/ConfigEditor.tsx)
 * and `streamingEnabled.metrics` (configuration/StreamingSection.tsx:66-72).
 */
export interface TempoJsonData extends HttpJsonData {
  tracesToLogsV2?: TraceToLogsOptionsV2;
  /** @deprecated Rewritten as `tracesToLogsV2` when the settings are saved. */
  tracesToLogs?: TraceToLogsOptions;
  tracesToMetrics?: TraceToMetricsOptions;
  tracesToProfiles?: TraceToProfilesOptions;
  /** The Prometheus the service graph and RED metrics come from. */
  serviceMap?: { datasourceUid?: LinkedDatasource<"prometheus"> };
  search?: { hide?: boolean; filters?: TraceqlFilter[] };
  nodeGraph?: { enabled?: boolean };
  spanBar?: { type?: string; tag?: string };
  tagLimit?: number;
  traceQuery?: { timeShiftEnabled?: boolean; spanStartTimeShift?: string; spanEndTimeShift?: string };
  streamingEnabled?: { search?: boolean; metrics?: boolean };
  timeRangeForTags?: number;
}

// ── Elasticsearch ─────────────────────────────────────────────────

/**
 * elasticsearch 12.8.2, bundled in grafana/grafana:13.2.2:
 * src/types.ts ElasticsearchOptions, DataLinkConfig, Interval, QueryType;
 * src/configuration/ElasticDetails.tsx, LogsConfig.tsx, ApiKeyConfig.tsx, utils.ts;
 * backend pkg/elasticsearch/elasticsearch.go NewDatasource
 * (github.com/grafana/grafana-elasticsearch-datasource@v12.8.2).
 *
 * HTTP client: yes. Backend uses settings.HTTPClientOptions() (with SigV4
 * middleware when sigV4Auth is on, service "es"), so the settings include `HttpJsonData`,
 * its sigV4 keys among them.
 */
export interface ElasticsearchJsonData extends HttpJsonData {
  /** Index name or pattern, e.g. "[logs-]YYYY.MM.DD". Falls back to the top-level `database` field when empty. */
  index?: string;
  /** Index pattern interval. Omit for "no pattern". */
  interval?: "Hourly" | "Daily" | "Weekly" | "Monthly" | "Yearly";
  /** Required by the backend; config editor defaults it to "@timestamp". */
  timeField?: string;
  /** Min time interval, e.g. "10s". Validated against /^\d+(ms|[Mwdhmsy])$/. */
  timeInterval?: string;
  /** Default 5. The config editor stores this as a string; the backend accepts number or numeric string. */
  maxConcurrentShardRequests?: number | string;
  logMessageField?: string;
  logLevelField?: string;
  includeFrozen?: boolean;
  /** Default "metrics". */
  defaultQueryMode?: "metrics" | "logs" | "raw_data" | "raw_document";
  /** When true, backend sends "Authorization: ApiKey <secureJsonData.apiKey>". */
  apiKeyAuth?: boolean;
  dataLinks?: ElasticsearchDataLink[];
}

export interface ElasticsearchDataLink {
  /** Exact field name or regex. */
  field?: string;
  /** URL, or the query when datasourceUid is set. */
  url?: string;
  urlDisplayLabel?: string;
  datasourceUid?: LinkedDatasource<TracingDatasourceType>;
}

export type ElasticsearchSecureJsonKey = "apiKey";

// ── OpenSearch ────────────────────────────────────────────────────

/**
 * grafana-opensearch-datasource, grafana/opensearch-datasource v2.34.4 (the
 * plugin is not bundled with grafana/grafana:13.2.2): src/types.ts
 * OpenSearchOptions, DataLinkConfig, Flavor; src/configuration/ConfigEditor.tsx,
 * OpenSearchDetails.tsx, LogsConfig.tsx.
 *
 * HTTP client: yes. The editor renders `DataSourceHttpSettings` with a
 * SigV4 editor from @grafana/aws-sdk, so the settings include `HttpJsonData`,
 * its sigV4 keys among them. The index is `database` in `jsonData`.
 */
export interface OpenSearchJsonData extends HttpJsonData {
  /** Index name or pattern, e.g. "[logs-]YYYY.MM.DD". */
  database?: string;
  /** Index pattern interval, as for Elasticsearch. Omit for "no pattern". */
  interval?: "Hourly" | "Daily" | "Weekly" | "Monthly" | "Yearly";
  /** The time field of the index; the editor defaults it to "@timestamp". */
  timeField?: string;
  /** Min time interval, e.g. "10s". */
  timeInterval?: string;
  /** The server's version, which the editor writes when it detects it (the "Get Version and Save" button). */
  version?: string;
  versionLabel?: string;
  flavor?: "elasticsearch" | "opensearch";
  maxConcurrentShardRequests?: number | string;
  logMessageField?: string;
  logLevelField?: string;
  /** Enable PPL queries; the editor treats an absent value as true. */
  pplEnabled?: boolean;
  /** Amazon OpenSearch Serverless: no index or version settings. */
  serverless?: boolean;
  dataLinks?: OpenSearchDataLink[];
}

export interface OpenSearchDataLink {
  /** Exact field name or regex. */
  field: string;
  /** URL, or the query when datasourceUid is set. */
  url: string;
  title?: string;
  datasourceUid?: LinkedDatasource<TracingDatasourceType>;
}

/** No secrets beyond the HTTP client's (`basicAuthPassword`, the sigV4 keys). */
export type OpenSearchSecureJsonKey = never;

// ── AWS auth (shared by CloudWatch) ───────────────────────────────

/**
 * @grafana/aws-sdk 0.12.0 src/types.ts AwsAuthDataSourceJsonData, AwsAuthType,
 * src/components/ConnectionConfig.tsx (github.com/grafana/grafana-aws-sdk-react@v0.12.0);
 * github.com/grafana/grafana-aws-sdk@v1.5.1 pkg/awsds/settings.go AWSDatasourceSettings.
 */
export interface AwsAuthJsonData extends CommonJsonData {
  /**
   * "arn" is the old name of "default"; "sharedCreds" is accepted by the Go
   * side only as an alias of "credentials". Unknown values fall back to "default".
   */
  authType?:
    | "keys"
    | "credentials"
    | "default"
    | "ec2_iam_role"
    | "grafana_assume_role"
    | "arn"
    | "sharedCreds";
  /** Go struct tag is "assumeRoleARN"; Go matching is case-insensitive, UI writes "assumeRoleArn". */
  assumeRoleArn?: string;
  externalId?: string;
  /** Grafana Assume Role only: use grafanaExternalId instead of the stack-level external ID. */
  usePerDatasourceExternalId?: boolean;
  /** Grafana Assume Role only: per-datasource external ID, "{stackExternalId}-{dsUid}". */
  grafanaExternalId?: string;
  /** Profile name in ~/.aws/credentials (authType "credentials"). */
  profile?: string;
  /** Region; this is what the UI writes. */
  defaultRegion?: string;
  /**
   * Read by the Go SDK before defaultRegion; if empty or "default" it falls
   * back to defaultRegion. Not written by the UI.
   */
  region?: string;
  /** Override for the AWS service endpoint. */
  endpoint?: string;
  /** Default "env" on the Go side. */
  proxyType?: "none" | "env" | "url";
  proxyUrl?: string;
  proxyUsername?: string;
}

export type AwsAuthSecureJsonKey = "accessKey" | "secretKey" | "sessionToken" | "proxyPassword";

// ── CloudWatch ────────────────────────────────────────────────────

/**
 * cloudwatch, core plugin in grafana/grafana v13.2.2:
 * public/app/plugins/datasource/cloudwatch/types.ts CloudWatchJsonData,
 * components/ConfigEditor/ConfigEditor.tsx, dataquery.gen.ts LogGroup;
 * pkg/tsdb/cloudwatch/models/settings.go CloudWatchSettings.
 * AWS auth keys from @grafana/aws-sdk 0.12.0 / grafana-aws-sdk v1.5.1 (see AwsAuthJsonData).
 *
 * HTTP client: no. The backend calls HTTPClientOptions() only to take
 * ProxyOptions for the secure socks proxy dialer, so of `HttpJsonData` only
 * the secure socks proxy keys apply.
 */
export interface CloudWatchJsonData extends AwsAuthJsonData {
  enableSecureSocksProxy?: boolean;
  secureSocksProxyUsername?: string;
  /** Comma-separated list of custom metric namespaces, e.g. "CWAgent". */
  customMetricsNamespaces?: string;
  /**
   * Logs query timeout. Duration string such as "30m" (Go time.ParseDuration),
   * or a number of nanoseconds. Backend default 30m.
   */
  logsTimeout?: string | number;
  /** X-Ray datasource used to build trace links from logs containing traceId. */
  tracingDatasourceUid?: LinkedDatasource<"grafana-x-ray-datasource">;
  /** Default log groups for new logs queries. */
  logGroups?: CloudWatchLogGroup[];
  /** @deprecated Use logGroups. The config editor migrates these names to logGroups; still read as a fallback. */
  defaultLogGroups?: string[];
  /**
   * @deprecated Legacy home of the credentials profile name. Use profile.
   * The config editor still checks jsonData.database when authType is "credentials".
   */
  database?: string;
  /** @deprecated Declared in types.ts but not read anywhere at v13.2.2. */
  timeField?: string;
}

/** public/app/plugins/datasource/cloudwatch/dataquery.gen.ts LogGroup (arn and name required there). */
export interface CloudWatchLogGroup {
  arn: string;
  name: string;
  /** Monitoring account ID, for cross-account observability. */
  accountId?: string;
  accountLabel?: string;
}

export type CloudWatchSecureJsonKey = AwsAuthSecureJsonKey | "secureSocksProxyPassword";

// ── Azure credentials (shared by Azure Monitor and MSSQL) ─────────

/**
 * @grafana/azure-sdk 0.1.0 src/credentials/AzureCredentials.ts,
 * src/credentials/AzureCredentialsConfig.ts, src/settings.ts, src/clouds.ts
 * (github.com/grafana/grafana-azure-sdk-react@v0.1.0);
 * github.com/grafana/grafana-azure-sdk-go/v2@v2.5.0 azcredentials/builder.go, azsettings/clouds.go.
 *
 * Stored in jsonData.azureCredentials. Secrets are never stored here; they go
 * to secureJsonData (azureClientSecret, password, clientCertificate,
 * privateKey, certificatePassword).
 */
export type AzureCloudName =
  | "AzureCloud"
  | "AzureChinaCloud"
  | "AzureUSGovernment"
  | "AzureCustomizedCloud"
  // Grafana's [azure] clouds config can define additional names.
  | (string & {});

export type AzureCredentials =
  | { authType: "msi" }
  | { authType: "workloadidentity" }
  | {
      authType: "clientsecret" | "clientsecret-obo";
      /** Required by the Go SDK. UI defaults it to Grafana's configured cloud. */
      azureCloud?: AzureCloudName;
      tenantId?: string;
      clientId?: string;
    }
  | {
      authType: "clientcertificate";
      azureCloud?: AzureCloudName;
      tenantId?: string;
      clientId?: string;
      /** Go SDK defaults to "pem" when empty. */
      certificateFormat?: "pem" | "pfx";
    }
  | {
      /** Entra ID username/password; secret in secureJsonData.password. */
      authType: "ad-password";
      userId?: string;
      clientId?: string;
    }
  | {
      authType: "currentuser";
      serviceCredentialsEnabled?: boolean;
      /** Fallback credentials used where there is no signed-in user (e.g. alerting). */
      serviceCredentials?:
        | { authType: "msi" }
        | { authType: "workloadidentity" }
        | { authType: "clientsecret"; azureCloud?: AzureCloudName; tenantId?: string; clientId?: string }
        | {
            authType: "clientcertificate";
            azureCloud?: AzureCloudName;
            tenantId?: string;
            clientId?: string;
            certificateFormat?: "pem" | "pfx";
          };
    };

// ── Azure Monitor ─────────────────────────────────────────────────

/**
 * grafana-azure-monitor-datasource, core plugin in grafana/grafana v13.2.2:
 * public/app/plugins/datasource/azuremonitor/types/types.ts AzureMonitorDataSourceJsonData,
 * credentials.ts getLegacyCredentials, components/ConfigEditor/MonitorConfig.tsx,
 * AzureCredentialsForm.tsx; pkg/tsdb/azuremonitor/types/types.go AzureMonitorSettings,
 * AzureMonitorCustomizedCloudSettings, azmoncredentials/builder.go, routes.go,
 * loganalytics/azure-log-analytics-datasource.go.
 * Base AzureDataSourceJsonData from @grafana/azure-sdk 0.1.0 src/settings.ts.
 *
 * HTTP client: yes. Each route's client is built from settings.HTTPClientOptions()
 * with Azure auth middleware added (pkg/tsdb/azuremonitor/httpclient.go), so
 * the settings include `HttpJsonData`. The config editor exposes timeout, keepCookies and
 * enableSecureSocksProxy. The "clientsecret-obo" and "currentuser" flows set
 * oauthPassThru (and currentuser also disableGrafanaCache) from the base.
 */
export interface AzureMonitorJsonData extends HttpJsonData {
  /**
   * Current credentials format. The UI offers msi, workloadidentity,
   * clientsecret, clientcertificate and currentuser (currentuser needs the
   * azureMonitorEnableUserAuth feature toggle).
   */
  azureCredentials?: AzureCredentials;
  /** Default subscription for queries and the resource picker. */
  subscriptionId?: string;
  basicLogsEnabled?: boolean;
  /** Use the Azure Monitor metrics batch API. */
  batchAPIEnabled?: boolean;
  /** Default Log Analytics workspace; still read by the frontend and backend settings. */
  logAnalyticsDefaultWorkspace?: string;
  /**
   * Routes used when the resolved cloud is "AzureCustomizedCloud". Keys are
   * route names: "Azure Monitor", "Azure Log Analytics", "Azure Resource Graph",
   * "Azure Traces", "Azure Portal", "traceql", "Azure Monitor Batch Metrics".
   * The Go struct has no json tags, so keys match case-insensitively.
   */
  customizedRoutes?: Record<string, { URL?: string; Scopes?: string[]; Headers?: Record<string, string> }>;

  // Legacy credentials, read by the backend (azmoncredentials/builder.go getFromLegacy)
  // when azureCredentials is absent; the UI rewrites them into azureCredentials on save.
  /** @deprecated Use azureCredentials.authType. Legacy backend path supports msi, workloadidentity, clientsecret, currentuser. */
  azureAuthType?: "msi" | "workloadidentity" | "clientsecret" | "currentuser";
  /** @deprecated Use azureCredentials.azureCloud. Legacy cloud names mapped by resolveLegacyCloudName. */
  cloudName?: "azuremonitor" | "chinaazuremonitor" | "govazuremonitor" | "customizedazuremonitor";
  /** @deprecated Use azureCredentials.tenantId. */
  tenantId?: string;
  /** @deprecated Use azureCredentials.clientId. */
  clientId?: string;

  /**
   * @deprecated Separate Log Analytics credentials are no longer supported.
   * Backend accepts boolean or "true"/"false" string; false makes Log Analytics queries fail.
   */
  azureLogAnalyticsSameAs?: boolean | "true" | "false";
  /** @deprecated Separate Log Analytics credentials; declared in types.ts, not read at v13.2.2. */
  logAnalyticsTenantId?: string;
  /** @deprecated Separate Log Analytics credentials; declared in types.ts, not read at v13.2.2. */
  logAnalyticsClientId?: string;
  /** @deprecated Separate Log Analytics credentials; declared in types.ts, not read at v13.2.2. */
  logAnalyticsSubscriptionId?: string;
  /** @deprecated Application Insights app; in Go AzureMonitorSettings but not used for queries at v13.2.2. */
  appInsightsAppId?: string;
}

export type AzureMonitorSecureJsonKey =
  /** Client secret for clientsecret / clientsecret-obo / currentuser fallback. */
  | "azureClientSecret"
  /** Legacy client secret name; read when azureClientSecret is absent. */
  | "clientSecret"
  | "clientCertificate"
  | "privateKey"
  | "certificatePassword"
  /** Entra password for "ad-password"; in the SDK but not offered by the Azure Monitor UI. */
  | "password"
  /** Deprecated Application Insights API key; declared in types.ts, not read at v13.2.2. */
  | "appInsightsApiKey";

// ── Google auth (shared by Cloud Monitoring and BigQuery) ─────────

/**
 * @grafana/google-sdk 0.6.0 dist/esm/index.d.ts DataSourceOptions,
 * dist/esm/types.js GoogleAuthType, components/AuthConfig.js, JWTForm.js,
 * WIFConfigEditor.js (npm tarball; the GitHub repo grafana/grafana-google-sdk-react
 * has no v0.6.0 tag); github.com/grafana/grafana-google-sdk-go@v0.4.2
 * pkg/utils/utils.go GetPrivateKey.
 */
export interface GoogleAuthJsonData {
  /**
   * Default "jwt". "workloadIdentityFederation" and "forwardOAuthIdentity"
   * are only offered in Grafana Cloud for Cloud Monitoring; BigQuery offers
   * forwardOAuthIdentity everywhere.
   */
  authenticationType?: "jwt" | "gce" | "workloadIdentityFederation" | "forwardOAuthIdentity";
  /** JWT: token_uri from the service account key. */
  tokenUri?: string;
  /** JWT: client_email from the service account key. */
  clientEmail?: string;
  /** Project used when a query does not name one. */
  defaultProject?: string;
  /** JWT: path to a private key file on the Grafana host; used instead of secureJsonData.privateKey when set. */
  privateKeyPath?: string;
  /** jwt/gce only. */
  usingImpersonation?: boolean;
  serviceAccountToImpersonate?: string;
  /** workloadIdentityFederation: required by the backend for that auth type. */
  workloadIdentityPoolProvider?: string;
  wifServiceAccountEmail?: string;
}

export type GoogleAuthSecureJsonKey = "privateKey";

// ── Google Cloud Monitoring ───────────────────────────────────────

/**
 * stackdriver 12.6.1, bundled in grafana/grafana:13.2.2:
 * src/types/types.ts CloudMonitoringOptions, src/components/ConfigEditor/ConfigEditor.tsx,
 * src/datasource.ts; backend pkg/cloudmonitoring/cloudmonitoring.go datasourceJSONData,
 * httpclient.go (github.com/grafana/grafana-cloudmonitoring-datasource@v12.6.1).
 * Google auth keys from @grafana/google-sdk 0.6.0 (see GoogleAuthJsonData).
 *
 * HTTP client: yes. Clients are built from settings.HTTPClientOptions() plus the
 * Google token middleware, so the settings include `HttpJsonData`. forwardOAuthIdentity and
 * workloadIdentityFederation rely on oauthPassThru from the base.
 */
export interface CloudMonitoringJsonData extends HttpJsonData, GoogleAuthJsonData {
  /**
   * gce auth: default project. The frontend uses it if set and otherwise asks
   * the backend (resource "gceDefaultProject") and caches it in memory only.
   */
  gceDefaultProject?: string;
  /** Default "googleapis.com". Service URLs become https://monitoring.<universeDomain> etc. */
  universeDomain?: string;
}

export type CloudMonitoringSecureJsonKey = GoogleAuthSecureJsonKey;

// ── Google BigQuery ───────────────────────────────────────────────

/**
 * grafana-bigquery-datasource 3.4.2 (not bundled in grafana/grafana:13.2.2):
 * github.com/grafana/google-bigquery-datasource@v3.4.2 src/types.ts BigQueryOptions,
 * QueryPriority, src/components/ConfigEditor.tsx, src/constants.ts PROCESSING_LOCATIONS;
 * pkg/bigquery/types/types.go BigQuerySettings, pkg/bigquery/settings.go.
 * Google auth keys from @grafana/google-sdk 0.6.1 (same .d.ts as 0.6.0).
 *
 * HTTP client: yes. pkg/bigquery/datasource.go builds clients from
 * config.HTTPClientOptions() (http_client.go adds the token middleware or,
 * with oauthPassThru, forwards headers), so the settings include `HttpJsonData`.
 */
export interface BigQueryJsonData extends HttpJsonData, GoogleAuthJsonData {
  /** Location code such as "US", "EU", "us-east5"; "" means automatic. */
  processingLocation?: string;
  /** Custom BigQuery API endpoint. */
  serviceEndpoint?: string;
  /**
   * Query byte limit. Must be a JSON number: the Go field is int64 and a
   * string fails settings unmarshal. Note the capitalised key.
   */
  MaxBytesBilled?: number;
  /** Limit dataset listings to datasets the credentials can access. */
  restrictToAccessibleDatasets?: boolean;
  /** Comma-separated extra datasets allowed when restrictToAccessibleDatasets is on. */
  additionalAllowedDatasets?: string;
  /** Declared in types.ts and the Go struct; no reader found at v3.4.2. */
  flatRateProject?: string;
  /** Declared in types.ts and the Go struct; the datasource-level value is not read at v3.4.2 (queries carry their own). */
  queryPriority?: "INTERACTIVE" | "BATCH";
}

export type BigQuerySecureJsonKey = GoogleAuthSecureJsonKey;

// ── Grafana Pyroscope ─────────────────────────────────────────────

/**
 * grafana-pyroscope-datasource 13.0.4, bundled in grafana/grafana:13.2.2:
 * src/types.ts PyroscopeDataSourceOptions, src/ConfigEditor.tsx;
 * backend pkg/grafana-pyroscope-datasource/query.go, instance.go
 * (github.com/grafana/grafana-pyroscope-datasource@v13.0.4).
 *
 * HTTP client: yes. settings.HTTPClientOptions() with ForwardHTTPHeaders, so
 * the settings include `HttpJsonData`. Config editor uses plugin-ui ConnectionSettings, Auth,
 * AdvancedHttpSettings and SecureSocksProxySettings.
 */
export interface PyroscopeJsonData extends HttpJsonData {
  /** Minimum step, e.g. "15s". Validated against /^\d+(ms|[Mwdhmsy])$/. */
  minStep?: string;
}

/** Pyroscope names no secure keys of its own; basic auth / TLS / header secrets come from the base. */
export type PyroscopeSecureJsonKey = never;

// ── SQL (PostgreSQL, MySQL, MSSQL) ────────────────────────────────

/**
 * grafana/grafana v13.2.2 packages/grafana-sql/src/types.ts SQLOptions,
 * SQLConnectionLimits; components/configuration/useMigrateDatabaseFields.ts,
 * ConnectionLimits.tsx. The three plugins depend on @grafana/sql 13.1.1.
 *
 * Differences from SQLOptions:
 * - user and url are left out: they are top-level datasource fields
 *   (settings.User / settings.URL), not jsonData, in all three backends.
 * - tlsAuth, tlsAuthWithCACert, tlsSkipVerify and timezone are moved to the
 *   plugins that read them (MySQL; MSSQL reads tlsSkipVerify).
 *
 * HTTP client: none of the SQL backends builds an HTTP client, so their settings do
 * not include `HttpJsonData`. All three honour enableSecureSocksProxy /
 * secureSocksProxyUsername through settings.ProxyClient().
 */
export interface SqlJsonData extends CommonJsonData {
  enableSecureSocksProxy?: boolean;
  secureSocksProxyUsername?: string;
  /**
   * Database name. The config editor migrates the deprecated top-level
   * `database` field into jsonData.database; backends fall back to the
   * top-level field when this is empty.
   */
  database?: string;
  /** Default from Grafana [sql_datasources] max_open_conns_default. */
  maxOpenConns?: number;
  /** Default from Grafana [sql_datasources] max_idle_conns_default. Not applied by the Postgres (pgx) backend. */
  maxIdleConns?: number;
  /** UI-only: keep maxIdleConns equal to maxOpenConns. Backends ignore it. */
  maxIdleConnsAuto?: boolean;
  /** Seconds. Default from Grafana [sql_datasources] max_conn_lifetime_default. */
  connMaxLifetime?: number;
  /** Min time interval, e.g. "1m". */
  timeInterval?: string;
}

/**
 * grafana-postgresql-datasource 13.0.3, bundled in grafana/grafana:13.2.2:
 * src/types.ts PostgresOptions, PostgresTLSModes, PostgresTLSMethods,
 * src/configuration/ConfigurationEditor.tsx (postgresVersions), useAutoDetectFeatures.ts;
 * backend pkg/postgresql/postgres.go, tlsmanager.go, sqleng/sql_engine.go JsonData
 * (github.com/grafana/grafana-postgresql-datasource@v13.0.3).
 *
 * Also provisioned under type "postgres" (Grafana's devenv/datasources.yaml uses it).
 * HTTP client: no (see SqlJsonData).
 */
export interface PostgresJsonData extends SqlJsonData {
  /**
   * libpq sslmode. UI default "require". The backend passes the value to the
   * connection string unchanged, so other libpq modes ("allow", "prefer")
   * would also connect, but the UI only offers these four.
   */
  sslmode?: "disable" | "require" | "verify-ca" | "verify-full";
  /** Default "file-path". "file-content" writes secureJsonData tlsCACert/tlsClientCert/tlsClientKey to temp files. */
  tlsConfigurationMethod?: "file-path" | "file-content";
  /** file-path method: CA certificate path on the Grafana host. */
  sslRootCertFile?: string;
  /** file-path method: client certificate path. */
  sslCertFile?: string;
  /** file-path method: client key path. */
  sslKeyFile?: string;
  /**
   * Server version as major*100+minor: 900..906, 1000, 1100, 1200, 1300, 1400,
   * 1500 ("15+"). UI default 903; auto-detected on save and may hold an
   * unlisted value. Frontend only (macro/SQL generation hints).
   */
  postgresVersion?: number;
  /** Enable TimescaleDB-specific macros. */
  timescaledb?: boolean;
}

/** password, plus TLS material for tlsConfigurationMethod "file-content" (pkg/postgresql/tlsmanager.go). */
export type PostgresSecureJsonKey = "password" | "tlsCACert" | "tlsClientCert" | "tlsClientKey" | "secureSocksProxyPassword";

/**
 * mysql 13.1.2, bundled in grafana/grafana:13.2.2:
 * src/types.ts MySQLOptions, src/configuration/ConfigurationEditor.tsx;
 * backend pkg/mysql/mysql.go, sqleng/sql_engine.go JsonData
 * (github.com/grafana/grafana-mysql-datasource@v13.1.2).
 *
 * HTTP client: no HTTP client, but the backend calls settings.HTTPClientOptions()
 * and sdkhttpclient.GetTLSConfig() to build the MySQL TLS config. So the TLS part
 * of the common settings applies (tlsAuth, tlsAuthWithCACert, tlsSkipVerify,
 * serverName, secure tlsCACert/tlsClientCert/tlsClientKey); timeout, headers,
 * cookies do not. The TLS flags are repeated here with the same names and types
 * as the base so the two can be combined.
 */
export interface MySQLJsonData extends SqlJsonData {
  /** Adds allowCleartextPasswords=true to the DSN. */
  allowCleartextPasswords?: boolean;
  /** Session time zone, e.g. "Europe/Berlin" or "+02:00"; sent as time_zone in the DSN. */
  timezone?: string;
  /** Use a TLS client certificate (secureJsonData tlsClientCert/tlsClientKey). */
  tlsAuth?: boolean;
  /** Verify the server with secureJsonData.tlsCACert. */
  tlsAuthWithCACert?: boolean;
  /** Adds tls=skip-verify when no CA/client cert is configured. */
  tlsSkipVerify?: boolean;
  /** TLS server name override, read through HTTPClientOptions(). Not shown in the MySQL config editor. */
  serverName?: string;
}

export type MySQLSecureJsonKey = "password" | "tlsCACert" | "tlsClientCert" | "tlsClientKey" | "secureSocksProxyPassword";

/**
 * mssql 13.0.5, bundled in grafana/grafana:13.2.2:
 * src/types.ts MssqlOptions, MSSQLAuthenticationType, MSSQLEncryptOptions,
 * src/configuration/ConfigurationEditor.tsx, Kerberos.tsx,
 * src/azureauth/AzureAuthSettings.tsx, AzureCredentialsForm.tsx, AzureCredentialsConfig.ts;
 * backend pkg/mssql/sqleng/connection.go generateConnectionString, sqleng/sql_engine.go JsonData,
 * kerberos/kerberos.go KerberosAuth, azure/connection.go, utils/utils.go
 * (github.com/grafana/grafana-mssql-datasource@v13.0.5).
 * Azure credential shape from @grafana/azure-sdk 0.1.0 / grafana-azure-sdk-go v2.5.0.
 *
 * HTTP client: no (see SqlJsonData). TLS is configured by the MSSQL driver from
 * encrypt / tlsSkipVerify / serverName / sslRootCertFile below, not by the
 * common TLS settings.
 */
export interface MSSQLJsonData extends SqlJsonData {
  /** Default "SQL Server Authentication". */
  authenticationType?:
    | "SQL Server Authentication"
    | "Windows Authentication"
    | "Azure AD Authentication"
    | "Windows AD: Username + password"
    | "Windows AD: Keytab"
    | "Windows AD: Credential cache"
    | "Windows AD: Credential cache file";
  /** String, not boolean. Backend default "false". */
  encrypt?: "disable" | "false" | "true";
  /** encrypt "true" only: sets TrustServerCertificate. */
  tlsSkipVerify?: boolean;
  /** encrypt "true" only: hostNameInCertificate. Go tag is "servername" (case-insensitive match). */
  serverName?: string;
  /** encrypt "true" only: path to the CA certificate on the Grafana host. */
  sslRootCertFile?: string;
  /** Seconds; 0 means driver default. */
  connectionTimeout?: number;
  /**
   * "Azure AD Authentication" only. The MSSQL UI offers clientsecret, msi,
   * ad-password and currentuser; the backend (azure/connection.go) handles
   * the same four.
   */
  azureCredentials?: AzureCredentials;
  /** "Windows AD: Keytab": keytab file path. */
  keytabFilePath?: string;
  /** "Windows AD: Credential cache": credential cache file path. */
  credentialCache?: string;
  /** "Windows AD: Credential cache file": JSON lookup file mapping address/database/user to a cache file. */
  credentialCacheLookupFile?: string;
  /** krb5 config file path. Default /etc/krb5.conf. */
  configFilePath?: string;
  /** krb5 udp_preference_limit. Default 1. Backend also accepts a numeric string. */
  UDPConnectionLimit?: number | string;
  /** krb5 dns_lookup_kdc, passed through as text; UI placeholder "true". */
  enableDNSLookupKDC?: string;
}

export type MSSQLSecureJsonKey =
  /** SQL/Kerberos password, and also the Entra password for azureCredentials.authType "ad-password". */
  | "password"
  /** azureCredentials clientsecret / currentuser fallback. */
  | "azureClientSecret"
  /** Legacy client secret name; the Go SDK reads it when azureClientSecret is absent. */
  | "clientSecret"
  | "secureSocksProxyPassword";

// ── by plugin type ───────────────────────────────────────────────

/** Each typed plugin's `jsonData`, by plugin id. `postgres` is the PostgreSQL plugin's old id, which Grafana still accepts. */
export interface DatasourceJsonDataTypes {
  prometheus: PrometheusJsonData;
  loki: LokiJsonData;
  tempo: TempoJsonData;
  elasticsearch: ElasticsearchJsonData;
  "grafana-opensearch-datasource": OpenSearchJsonData;
  cloudwatch: CloudWatchJsonData;
  "grafana-azure-monitor-datasource": AzureMonitorJsonData;
  stackdriver: CloudMonitoringJsonData;
  "grafana-bigquery-datasource": BigQueryJsonData;
  "grafana-pyroscope-datasource": PyroscopeJsonData;
  "grafana-postgresql-datasource": PostgresJsonData;
  postgres: PostgresJsonData;
  mysql: MySQLJsonData;
  mssql: MSSQLJsonData;
}

/** Each typed plugin's `secureJsonData` keys, by plugin id. */
export interface DatasourceSecureJsonKeys {
  prometheus: HttpSecureJsonKey;
  loki: HttpSecureJsonKey;
  tempo: HttpSecureJsonKey;
  elasticsearch: HttpSecureJsonKey | ElasticsearchSecureJsonKey;
  "grafana-opensearch-datasource": HttpSecureJsonKey | OpenSearchSecureJsonKey;
  cloudwatch: CloudWatchSecureJsonKey;
  "grafana-azure-monitor-datasource": HttpSecureJsonKey | AzureMonitorSecureJsonKey;
  stackdriver: HttpSecureJsonKey | CloudMonitoringSecureJsonKey;
  "grafana-bigquery-datasource": HttpSecureJsonKey | BigQuerySecureJsonKey;
  "grafana-pyroscope-datasource": HttpSecureJsonKey | PyroscopeSecureJsonKey;
  "grafana-postgresql-datasource": PostgresSecureJsonKey;
  postgres: PostgresSecureJsonKey;
  mysql: MySQLSecureJsonKey;
  mssql: MSSQLSecureJsonKey;
}

/** The plugin ids whose settings are typed. */
export type TypedDatasourceType = keyof DatasourceJsonDataTypes;

/** `jsonData` for a datasource of plugin type `T`: typed for the plugins above, any object for the rest. */
export type DatasourceJsonData<T extends string = string> = T extends TypedDatasourceType ? DatasourceJsonDataTypes[T] : Record<string, unknown>;

/** `secureJsonData` for a datasource of plugin type `T`: the plugin's keys, each a string; any keys for other plugins. */
export type DatasourceSecureJsonData<T extends string = string> = T extends TypedDatasourceType
  ? { [K in DatasourceSecureJsonKeys[T]]?: string }
  : Record<string, string>;

// ── links, for the importer ────────────────────────────────────────

/**
 * One place in a plugin's `jsonData` that names another datasource by uid,
 * and the plugin types the field's type accepts there. The importer turns
 * such a uid into a reference to the `Datasource` of the same file that has
 * it, when that datasource is of one of these types; `*` stands for every
 * element of an array.
 */
export interface JsonDataLink {
  /** The plugin types whose settings have this field; every plugin when left out. */
  readonly on?: readonly string[];
  readonly path: readonly string[];
  readonly targets: readonly string[];
}

/** Every `LinkedDatasource` field in the types above. */
export const JSONDATA_LINKS: readonly JsonDataLink[] = [
  { path: ["alertmanagerUid"], targets: ["alertmanager"] },
  { on: ["prometheus"], path: ["exemplarTraceIdDestinations", "*", "datasourceUid"], targets: TRACING_DATASOURCE_TYPES },
  { on: ["loki"], path: ["derivedFields", "*", "datasourceUid"], targets: TRACING_DATASOURCE_TYPES },
  { on: ["tempo"], path: ["tracesToLogsV2", "datasourceUid"], targets: TRACE_TO_LOGS_DATASOURCE_TYPES },
  { on: ["tempo"], path: ["tracesToLogs", "datasourceUid"], targets: TRACE_TO_LOGS_DATASOURCE_TYPES },
  { on: ["tempo"], path: ["tracesToMetrics", "datasourceUid"], targets: TRACE_TO_METRICS_DATASOURCE_TYPES },
  { on: ["tempo"], path: ["tracesToProfiles", "datasourceUid"], targets: ["grafana-pyroscope-datasource"] },
  { on: ["tempo"], path: ["serviceMap", "datasourceUid"], targets: ["prometheus"] },
];
