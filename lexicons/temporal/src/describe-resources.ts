/**
 * Live introspection of a Temporal cluster — implements the
 * LexiconPlugin.describeResources() contract for the temporal lexicon.
 *
 * Connects to the cluster identified by the chant config profile that
 * matches the current environment (falls back to defaultProfile), then lists:
 *   - Namespaces        via workflowService.listNamespaces
 *   - SearchAttributes  via operatorService.listSearchAttributes (per namespace)
 *   - Schedules         via scheduleClient.list (per namespace)
 *
 * Results are keyed by server-side identifier (e.g. "namespace/prod",
 * "searchAttribute/prod/Project", "schedule/prod/daily-report"). Mapping back
 * to chant entity names is a separate concern (would need entity props passed
 * through the plugin contract).
 */

import { loadChantConfig } from "@intentius/chant/config";
import {
  loadTemporalClient,
  connectionOptions,
  resolveProfile,
  type WorkerProfile,
} from "@intentius/chant/cli/handlers/run-client";
import type { ResourceMetadata } from "@intentius/chant/lexicon";

interface NamespaceListResponse {
  namespaces?: Array<{
    namespaceInfo?: {
      name?: string;
      state?: number | string;
      description?: string;
      ownerEmail?: string;
    } | null;
    config?: {
      workflowExecutionRetentionTtl?: { seconds?: number | bigint | { toNumber(): number } } | null;
    } | null;
    isGlobalNamespace?: boolean;
  }>;
  nextPageToken?: Uint8Array | null;
}

interface SearchAttributesResponse {
  customAttributes?: Record<string, number | string> | null;
  systemAttributes?: Record<string, number | string> | null;
}

interface ScheduleSummary {
  scheduleId?: string;
  spec?: { cronExpressions?: string[] } | null;
  action?: { type?: string; workflowType?: string } | null;
  state?: { paused?: boolean; note?: string } | null;
}

interface RichConnection {
  workflowService: {
    listNamespaces(req: { pageSize?: number; nextPageToken?: Uint8Array }): Promise<NamespaceListResponse>;
  };
  operatorService: {
    listSearchAttributes(req: { namespace: string }): Promise<SearchAttributesResponse>;
  };
  close?(): Promise<void>;
}

interface RichClient {
  scheduleClient: {
    list(opts: { namespace?: string }): AsyncIterable<ScheduleSummary>;
  };
}

interface RichClientModule {
  Connection: { connect(opts: Record<string, unknown>): Promise<RichConnection> };
  Client: new (opts: { connection: RichConnection; namespace?: string }) => RichClient;
}

const NAMESPACE_STATE_NAMES: Record<number, string> = {
  0: "UNSPECIFIED",
  1: "REGISTERED",
  2: "DEPRECATED",
  3: "DELETED",
};

const VALUE_TYPE_NAMES: Record<number, string> = {
  0: "Unspecified",
  1: "Text",
  2: "Keyword",
  3: "Int",
  4: "Double",
  5: "Bool",
  6: "Datetime",
  7: "KeywordList",
};

function namespaceStateToString(state: number | string | undefined): string {
  if (typeof state === "string") return state;
  if (typeof state === "number") return NAMESPACE_STATE_NAMES[state] ?? `STATE_${state}`;
  return "UNKNOWN";
}

function valueTypeToString(t: number | string | undefined): string {
  if (typeof t === "string") return t;
  if (typeof t === "number") return VALUE_TYPE_NAMES[t] ?? `TYPE_${t}`;
  return "Unknown";
}

function retentionTtlToSeconds(
  ttl: { seconds?: number | bigint | { toNumber(): number } } | null | undefined,
): number | undefined {
  if (!ttl?.seconds) return undefined;
  const s = ttl.seconds;
  if (typeof s === "number") return s;
  if (typeof s === "bigint") return Number(s);
  if (typeof s === "object" && "toNumber" in s) return s.toNumber();
  return undefined;
}

function resolveProfileForEnv(
  config: Record<string, unknown>,
  environment: string,
): WorkerProfile {
  // Try env-named profile first, fall back to defaultProfile.
  try {
    return resolveProfile(config, environment);
  } catch {
    return resolveProfile(config);
  }
}

async function paginateNamespaces(connection: RichConnection): Promise<NonNullable<NamespaceListResponse["namespaces"]>> {
  const all: NonNullable<NamespaceListResponse["namespaces"]> = [];
  let nextPageToken: Uint8Array | undefined;
  do {
    const res = await connection.workflowService.listNamespaces({
      pageSize: 100,
      ...(nextPageToken && { nextPageToken }),
    });
    if (res.namespaces) all.push(...res.namespaces);
    nextPageToken = res.nextPageToken && res.nextPageToken.length > 0 ? res.nextPageToken : undefined;
  } while (nextPageToken);
  return all;
}

/**
 * Build reverse-lookup maps from server-side identifiers back to chant
 * entity names, using the `entities` map passed via the plugin contract.
 *
 * Mapping rules:
 *   - Namespace:       props.name              -> entity name
 *   - SearchAttribute: <ns>/<props.name>       -> entity name
 *   - Schedule:        <ns>/<props.scheduleId> -> entity name
 *
 * For SearchAttribute, the namespace defaults to the *first declared
 * Temporal::Namespace's name* if the entity itself doesn't pin one — this
 * matches the serializer's behavior when emitting registration commands.
 */
function buildEntityIndex(
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>,
): {
  namespaceByName: Map<string, string>;
  searchAttrByKey: Map<string, string>;
  scheduleByKey: Map<string, string>;
  defaultNamespace?: string;
} {
  const namespaceByName = new Map<string, string>();
  const searchAttrByKey = new Map<string, string>();
  const scheduleByKey = new Map<string, string>();
  let defaultNamespace: string | undefined;

  for (const [entityName, { entityType, props }] of entities) {
    if (entityType === "Temporal::Namespace") {
      const nsName = (props.name as string) || "";
      if (nsName) {
        namespaceByName.set(nsName, entityName);
        if (!defaultNamespace) defaultNamespace = nsName;
      }
    }
  }

  for (const [entityName, { entityType, props }] of entities) {
    if (entityType === "Temporal::SearchAttribute") {
      const attrName = (props.name as string) || "";
      const ns = (props.namespace as string) || defaultNamespace || "";
      if (attrName && ns) searchAttrByKey.set(`${ns}/${attrName}`, entityName);
    } else if (entityType === "Temporal::Schedule") {
      const scheduleId = (props.scheduleId as string) || "";
      const ns = (props.namespace as string) || defaultNamespace || "";
      if (scheduleId && ns) scheduleByKey.set(`${ns}/${scheduleId}`, entityName);
    }
  }

  return { namespaceByName, searchAttrByKey, scheduleByKey, defaultNamespace };
}

export async function describeResources(options: {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}): Promise<Record<string, ResourceMetadata>> {
  const { config } = await loadChantConfig(process.cwd());
  const profile = resolveProfileForEnv(config as Record<string, unknown>, options.environment);

  const mod = (await loadTemporalClient()) as unknown as RichClientModule;
  const connection = await mod.Connection.connect(connectionOptions(profile));
  const client = new mod.Client({ connection });

  const idx = buildEntityIndex(options.entities);
  const result: Record<string, ResourceMetadata> = {};

  // Map a server-side identifier to a chant entity name when possible;
  // otherwise fall back to the server-side prefixed key (orphan).
  const keyForNamespace = (name: string): string =>
    idx.namespaceByName.get(name) ?? `namespace/${name}`;
  const keyForSearchAttr = (ns: string, attr: string): string =>
    idx.searchAttrByKey.get(`${ns}/${attr}`) ?? `searchAttribute/${ns}/${attr}`;
  const keyForSchedule = (ns: string, scheduleId: string): string =>
    idx.scheduleByKey.get(`${ns}/${scheduleId}`) ?? `schedule/${ns}/${scheduleId}`;

  try {
    const namespaces = await paginateNamespaces(connection);

    for (const ns of namespaces) {
      const name = ns.namespaceInfo?.name;
      if (!name) continue;

      result[keyForNamespace(name)] = {
        type: "Temporal::Namespace",
        physicalId: name,
        status: namespaceStateToString(ns.namespaceInfo?.state),
        attributes: pruneUndefined({
          description: ns.namespaceInfo?.description,
          ownerEmail: ns.namespaceInfo?.ownerEmail,
          isGlobalNamespace: ns.isGlobalNamespace,
          retentionSeconds: retentionTtlToSeconds(ns.config?.workflowExecutionRetentionTtl ?? undefined),
        }),
      };

      // SearchAttributes — failure on one namespace shouldn't abort others.
      try {
        const sa = await connection.operatorService.listSearchAttributes({ namespace: name });
        for (const [attrName, valueType] of Object.entries(sa.customAttributes ?? {})) {
          result[keyForSearchAttr(name, attrName)] = {
            type: "Temporal::SearchAttribute",
            physicalId: `${name}/${attrName}`,
            status: "REGISTERED",
            attributes: {
              valueType: valueTypeToString(valueType),
              namespace: name,
            },
          };
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[temporal] failed to list search attributes for namespace "${name}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Schedules — same fail-soft policy.
      try {
        for await (const s of client.scheduleClient.list({ namespace: name })) {
          if (!s.scheduleId) continue;
          result[keyForSchedule(name, s.scheduleId)] = {
            type: "Temporal::Schedule",
            physicalId: `${name}/${s.scheduleId}`,
            status: s.state?.paused ? "PAUSED" : "ACTIVE",
            attributes: pruneUndefined({
              namespace: name,
              workflowType: s.action?.workflowType,
              cronExpressions: s.spec?.cronExpressions,
              note: s.state?.note,
            }),
          };
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[temporal] failed to list schedules for namespace "${name}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } finally {
    if (typeof connection.close === "function") {
      try { await connection.close(); } catch { /* best-effort */ }
    }
  }

  return result;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
