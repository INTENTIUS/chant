/**
 * Temporal deep observation (#1088) — the temporal row of the deep-observe
 * contract (#1014).
 *
 * The transport is unchanged from the thin path (./describe-resources.ts): the
 * same chant-config-resolved profile, the same Connection/Client seam
 * (`@intentius/chant/cli/handlers/run-client`), the same namespace/schedule/
 * search-attribute correlation (`buildEntityIndex`). What's different is
 * depth — the Temporal client already returns the server's full
 * configuration for a namespace and for a schedule; `describeResources()`
 * keeps a curated handful of fields from each. This reader keeps the rest.
 *
 * ## Why the live tree is reshaped, not passed through raw
 *
 * AWS's deep reader (`lexicons/aws/src/deep-observe.ts`) passes the Cloud
 * Control payload through almost untouched, because chant's AWS resource
 * classes mirror CloudFormation's own property vocabulary 1:1 — `Tags`,
 * `VersioningConfiguration.Status` — so the declared tree and the live tree
 * already speak the same language before normalization runs. Temporal's
 * resources (`TemporalNamespaceProps`, `TemporalScheduleProps`,
 * `./resources.ts`) are not a mirror of the wire proto; they are a small,
 * hand-designed shape layered over it — `retention: "7d"` versus the proto's
 * `workflowExecutionRetentionTtl: { seconds: 604800 }`. Returning the raw
 * client response here would produce paths that never match a declared path
 * (`config.workflowExecutionRetentionTtl.seconds` has no declared
 * counterpart, ever), which is permanent "undeclared" noise on every read,
 * not signal. So this reader translates each high-signal field into the
 * exact key name and value shape the declared props use, before
 * `normalizeDeepProperties` ever runs.
 *
 * ## Namespaces
 *
 * `workflowService.listNamespaces()` — the same bulk call the thin path
 * makes — already returns the full per-namespace config (retention,
 * archival state and URI, description, owner email, the global-namespace
 * flag). There is no second, deeper call the way AWS needs Cloud Control on
 * top of `describe-stack-resources`.
 *
 * Retention is the field the epic names as high-signal, and it is also the
 * one place a naive pass-through breaks: the server reports it in seconds,
 * chant declares it as a duration string ("30d", "720h", "2592000s" are all
 * 30 days). {@link reconcileDuration} echoes the declared string back
 * verbatim when it parses to the same number of seconds, so a user's choice
 * of unit is never itself reported as drift, and reformats to a canonical
 * string only when the values genuinely differ.
 *
 * ## Schedules
 *
 * `scheduleClient.list()` (the thin path's call) is a summary — cron
 * expressions and a workflow type, nothing about policies, retry, or the
 * full triggered-workflow action. The full config this row promises needs
 * the schedule handle's `describe()`, one call per declared schedule — the
 * same "cheap list, deep describe per resource" shape AWS's
 * `describe-stack-resources` → `cloudcontrol get-resource` uses. Since every
 * declared `Temporal::Schedule` entity already carries its own
 * `scheduleId`/`namespace`, there is no need to list schedules at all; each
 * is described directly by id.
 *
 * `describe()`'s `info` (recent/next action history, run counters) is
 * server-populated telemetry with no declared counterpart of any kind — it is
 * never read into the tree at all, rather than read and then pruned, since
 * chant's schedule model has nothing to compare it against.
 *
 * ## Nothing here talks to a real cluster on its own terms
 *
 * Every call goes through the same `loadTemporalClient()` +
 * `resolveProfileForEnv()` seam `describe-resources.ts` uses, resolved from
 * `temporal.profiles.<environment>` (the row's own acceptance criterion) — a
 * test that replaces `@intentius/chant/cli/handlers/run-client` never
 * touches a socket.
 */

import { loadChantConfig } from "@intentius/chant/config";
import {
  loadTemporalClient,
  connectionOptions,
} from "@intentius/chant/cli/handlers/run-client";
import type {
  DeepArrayElement,
  DeepNode,
  DeepNormalizationHooks,
  DeepObservationResult,
  DeepResourceObservation,
  UnobservedEntity,
} from "@intentius/chant/lexicon";
import { deepObservation, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import {
  resolveProfileForEnv,
  paginateNamespaces,
  buildEntityIndex,
  retentionTtlToSeconds,
  valueTypeToString,
  pruneUndefined,
  type RichConnection,
  type RichClientModule,
  type NamespaceListResponse,
  type SearchAttributesResponse,
} from "./describe-resources";
import type { TemporalScheduleProps } from "./resources";

// ── Duration reconciliation ─────────────────────────────────────────────────
//
// chant declares durations as free-form strings ("7d", "30m", "1h30m"); the
// Temporal client returns them as numbers (seconds for namespace retention,
// milliseconds for schedule timeouts/retry intervals). Structural diffing
// compares raw values, so without reconciliation any declared duration would
// permanently disagree with its live counterpart in every unit but the one
// the reader happens to format in.

const DURATION_UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
const DURATION_TOKEN = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi;

/** Parse a chant duration string ("7d", "1h30m", "90") to a number of seconds. */
export function parseDurationSeconds(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  let total = 0;
  let matched = false;
  for (const m of trimmed.matchAll(DURATION_TOKEN)) {
    matched = true;
    total += Number(m[1]) * DURATION_UNIT_SECONDS[m[2].toLowerCase()];
  }
  return matched ? total : undefined;
}

/** Format a number of seconds as a single-unit duration string, largest whole unit first. */
export function formatDurationSeconds(totalSeconds: number): string {
  if (totalSeconds === 0) return "0s";
  if (Number.isInteger(totalSeconds)) {
    if (totalSeconds % 86400 === 0) return `${totalSeconds / 86400}d`;
    if (totalSeconds % 3600 === 0) return `${totalSeconds / 3600}h`;
    if (totalSeconds % 60 === 0) return `${totalSeconds / 60}m`;
    return `${totalSeconds}s`;
  }
  return `${Math.round(totalSeconds * 1000)}ms`;
}

/**
 * The value a duration-shaped live field reports. When the declared string
 * parses to the same number of seconds, the declared string is echoed back
 * verbatim — so "30d", "720h" and "2592000s" all read as unchanged against a
 * live value of 2,592,000 seconds, regardless of which unit the author wrote
 * in source. Only a genuine numeric difference is reformatted and reported.
 */
export function reconcileDuration(declared: unknown, liveSeconds: number): string {
  if (typeof declared === "string") {
    const declaredSeconds = parseDurationSeconds(declared);
    if (declaredSeconds !== undefined && Math.abs(declaredSeconds - liveSeconds) < 0.001) return declared;
  }
  return formatDurationSeconds(liveSeconds);
}

/** {@link reconcileDuration} for schedule fields, which the client returns in milliseconds. */
function reconcileDurationMs(declared: unknown, liveMs: number): string {
  return reconcileDuration(declared, liveMs / 1000);
}

// ── Namespace archival ───────────────────────────────────────────────────────

/** `temporal.api.enums.v1.ArchivalState` — Unspecified(0)/Disabled(1)/Enabled(2). */
const ARCHIVAL_STATE_NAMES: Record<number, string> = { 0: "Unspecified", 1: "Disabled", 2: "Enabled" };

function archivalStateToString(state: number | string | undefined): string {
  if (typeof state === "string") return state;
  if (typeof state === "number") return ARCHIVAL_STATE_NAMES[state] ?? `STATE_${state}`;
  return "Disabled";
}

// ── Noise rules (#1088) ──────────────────────────────────────────────────────

/**
 * Values Temporal reports when nobody declared the property — subtracted
 * only where source is silent (`node.side === "live" && node.counterpart ===
 * "absent"`), same as AWS's `AWS_SERVICE_DEFAULTS`. `retention` is chant's own
 * default rather than the server's: the serializer always sends an explicit
 * `--retention` flag (`props.retention ?? "7d"`, see ./serializer.ts), so an
 * omitted declaration deploys to exactly 7 days, never "whatever the cluster
 * defaults to".
 */
export const TEMPORAL_NAMESPACE_DEFAULTS: Record<string, unknown> = {
  retention: "7d",
  description: "",
  ownerEmail: "",
  isGlobalNamespace: false,
  historyArchivalState: "Disabled",
  historyArchivalUri: "",
  visibilityArchivalState: "Disabled",
  visibilityArchivalUri: "",
};

/**
 * Same idea for a schedule's optional policy/state fields. `state` is also
 * listed whole (not just its two leaves): a schedule that never declares
 * `state` at all has nothing on the declared side to prune *against* except
 * the wrapper itself, and pruning only `state.paused`/`state.note`
 * individually would leave an empty `state: {}` behind — itself a spurious
 * "undeclared" finding, since an empty object is still a value distinct from
 * no `state` key at all (the same reason {@link flattenDeepProperties} in
 * core treats `{}`/`[]` as leaves). Matching the whole node first, before its
 * children are ever visited, drops the wrapper outright when it is exactly at
 * rest.
 */
export const TEMPORAL_SCHEDULE_DEFAULTS: Record<string, unknown> = {
  state: { paused: false, note: "" },
  "policies.pauseOnFailure": false,
  "state.paused": false,
  "state.note": "",
};

const TEMPORAL_DEFAULTS_BY_TYPE: Record<string, Record<string, unknown>> = {
  "Temporal::Namespace": TEMPORAL_NAMESPACE_DEFAULTS,
  "Temporal::Schedule": TEMPORAL_SCHEDULE_DEFAULTS,
};

/**
 * The temporal lexicon's noise rules. Namespaces and schedules are read
 * already reshaped into chant's own declared vocabulary (see the module doc),
 * so — unlike AWS — there is no server-populated *identity* field left in the
 * tree to prune by name: an arn-shaped id would need its own key, and this
 * reader never gives it one. What's left is exactly what the issue calls out:
 * default subtraction, kept explicit rather than schema-derived because the
 * surface is small enough to enumerate by hand.
 */
export const temporalDeepNormalizationHooks: DeepNormalizationHooks = {
  prune(node: DeepNode): boolean {
    if (node.side !== "live" || node.counterpart !== "absent") return false;
    const defaults = TEMPORAL_DEFAULTS_BY_TYPE[node.entityType];
    if (!defaults || !Object.prototype.hasOwnProperty.call(defaults, node.pattern)) return false;
    return deepEqualDefault(defaults[node.pattern], node.value);
  },

  /**
   * `cronExpressions`, `intervals` and `nonRetryableErrorTypes` are sets —
   * Temporal fires every entry independently, and the CLI/console appends
   * rather than preserving chant's declared order. `args` is a positional
   * call, so it is deliberately absent here and stays in source order.
   */
  orderKey(element: DeepArrayElement): string | undefined {
    const name = lastSegment(element.pattern);
    const el = element.element;
    if (name === "cronExpressions" || name === "nonRetryableErrorTypes") {
      return typeof el === "string" ? el : canonicalJson(el);
    }
    if (name === "intervals") return canonicalJson(el);
    return undefined;
  },
};

/** Key-order-independent equality, so a default expressed as a whole object (`state`) matches regardless of field order. */
function deepEqualDefault(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    ) ?? ""
  );
}

/** The final segment of an index-erased pattern (`spec.intervals[]` → `intervals`). */
function lastSegment(pattern: string): string {
  const withoutIndex = pattern.replace(/\[\]$/, "");
  const dot = withoutIndex.lastIndexOf(".");
  return dot === -1 ? withoutIndex : withoutIndex.slice(dot + 1);
}

// ── Schedule describe() ──────────────────────────────────────────────────────

/** The subset of `ScheduleDescription` this reader reads. Locally typed, like the thin path's `RichClient` — this file never imports `@temporalio/client` types directly. */
export interface RichScheduleDescription {
  schedule?: {
    spec?: {
      cronExpressions?: string[];
      intervals?: Array<{ every?: number; offset?: number }>;
    } | null;
    action?: {
      workflowType?: string | { name?: string };
      taskQueue?: string;
      args?: unknown[];
      memo?: Record<string, unknown>;
      searchAttributes?: Record<string, unknown>;
      workflowExecutionTimeout?: number;
      workflowRunTimeout?: number;
      retryPolicy?: {
        initialInterval?: number;
        backoffCoefficient?: number;
        maximumAttempts?: number;
        maximumInterval?: number;
        nonRetryableErrorTypes?: string[];
      } | null;
    } | null;
    policies?: {
      overlap?: string;
      catchupWindow?: number;
      pauseOnFailure?: boolean;
    } | null;
    state?: {
      paused?: boolean;
      note?: string;
    } | null;
  };
}

interface RichScheduleHandle {
  describe(): Promise<RichScheduleDescription>;
}

interface RichDeepClient {
  scheduleClient: {
    getHandle(scheduleId: string, opts?: { namespace?: string }): RichScheduleHandle;
  };
}

function workflowTypeName(wt: string | { name?: string } | undefined): string | undefined {
  return typeof wt === "string" ? wt : wt?.name;
}

/** Build the live property tree for one schedule, in `TemporalScheduleProps`' own shape. */
function buildScheduleProperties(
  described: RichScheduleDescription,
  scheduleId: string,
  namespace: string,
  declaredProps: Record<string, unknown>,
): Record<string, unknown> {
  const schedule = described.schedule ?? {};
  const spec = schedule.spec ?? {};
  const action = schedule.action ?? {};
  const policies = schedule.policies ?? {};
  const state = schedule.state ?? {};

  const declaredAction = declaredProps.action as TemporalScheduleProps["action"] | undefined;
  const declaredRetry = declaredAction?.workflowRetryPolicy;
  const declaredIntervals = (declaredProps.spec as TemporalScheduleProps["spec"] | undefined)?.intervals;
  const declaredPolicies = declaredProps.policies as TemporalScheduleProps["policies"] | undefined;

  return {
    scheduleId,
    namespace,
    spec: pruneUndefined({
      cronExpressions: spec.cronExpressions,
      intervals: spec.intervals?.map((interval, i) =>
        pruneUndefined({
          every: interval.every !== undefined ? reconcileDurationMs(declaredIntervals?.[i]?.every, interval.every) : undefined,
          offset: interval.offset !== undefined ? reconcileDurationMs(declaredIntervals?.[i]?.offset, interval.offset) : undefined,
        }),
      ),
    }),
    action: pruneUndefined({
      workflowType: workflowTypeName(action.workflowType),
      taskQueue: action.taskQueue,
      args: action.args,
      memo: action.memo,
      searchAttributes: action.searchAttributes,
      workflowExecutionTimeout:
        action.workflowExecutionTimeout !== undefined
          ? reconcileDurationMs(declaredAction?.workflowExecutionTimeout, action.workflowExecutionTimeout)
          : undefined,
      workflowRunTimeout:
        action.workflowRunTimeout !== undefined
          ? reconcileDurationMs(declaredAction?.workflowRunTimeout, action.workflowRunTimeout)
          : undefined,
      workflowRetryPolicy: action.retryPolicy
        ? pruneUndefined({
            initialInterval:
              action.retryPolicy.initialInterval !== undefined
                ? reconcileDurationMs(declaredRetry?.initialInterval, action.retryPolicy.initialInterval)
                : undefined,
            backoffCoefficient: action.retryPolicy.backoffCoefficient,
            maximumAttempts: action.retryPolicy.maximumAttempts,
            maximumInterval:
              action.retryPolicy.maximumInterval !== undefined
                ? reconcileDurationMs(declaredRetry?.maximumInterval, action.retryPolicy.maximumInterval)
                : undefined,
            nonRetryableErrorTypes: action.retryPolicy.nonRetryableErrorTypes,
          })
        : undefined,
    }),
    policies: pruneUndefined({
      overlap: policies.overlap,
      catchupWindow:
        policies.catchupWindow !== undefined
          ? reconcileDurationMs(declaredPolicies?.catchupWindow, policies.catchupWindow)
          : undefined,
      pauseOnFailure: policies.pauseOnFailure ?? false,
    }),
    state: pruneUndefined({
      paused: state.paused ?? false,
      note: state.note ?? "",
    }),
  };
}

/** Build the live property tree for one namespace, in `TemporalNamespaceProps`' own shape. */
function buildNamespaceProperties(
  ns: NonNullable<NamespaceListResponse["namespaces"]>[number],
  declaredProps: Record<string, unknown>,
): Record<string, unknown> {
  const seconds = retentionTtlToSeconds(ns.config?.workflowExecutionRetentionTtl ?? undefined);
  const config = ns.config as {
    historyArchivalState?: number | string;
    historyArchivalUri?: string;
    visibilityArchivalState?: number | string;
    visibilityArchivalUri?: string;
  } | null | undefined;

  return {
    name: ns.namespaceInfo?.name ?? (declaredProps.name as string | undefined),
    retention: seconds !== undefined ? reconcileDuration(declaredProps.retention, seconds) : "7d",
    description: ns.namespaceInfo?.description ?? "",
    ownerEmail: ns.namespaceInfo?.ownerEmail ?? "",
    isGlobalNamespace: ns.isGlobalNamespace ?? false,
    historyArchivalState: archivalStateToString(config?.historyArchivalState),
    historyArchivalUri: config?.historyArchivalUri ?? "",
    visibilityArchivalState: archivalStateToString(config?.visibilityArchivalState),
    visibilityArchivalUri: config?.visibilityArchivalUri ?? "",
  };
}

// ── The reader ───────────────────────────────────────────────────────────────

export interface TemporalDeepObserveOptions {
  environment: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}

/**
 * Read the live property tree for each declared namespace/schedule/
 * search-attribute entity. Connection and profile-resolution failures
 * propagate (the whole-lexicon-failure case, #1089) exactly as
 * `describeResources()`'s do; a failure reading one namespace's search
 * attributes or one schedule's config is fail-soft, matching the thin path's
 * own per-namespace convention.
 */
export async function observeResourcesDeepTemporal(
  options: TemporalDeepObserveOptions,
): Promise<DeepObservationResult> {
  const { config } = await loadChantConfig(process.cwd());
  const profile = resolveProfileForEnv(config as Record<string, unknown>, options.environment);

  const mod = (await loadTemporalClient()) as unknown as RichClientModule;
  const connection: RichConnection = await mod.Connection.connect(connectionOptions(profile));
  const client = new mod.Client({ connection }) as unknown as RichDeepClient;

  const idx = buildEntityIndex(options.entities);
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  try {
    const namespaces = await paginateNamespaces(connection);
    const namespaceByName = new Map(
      namespaces.filter((n) => n.namespaceInfo?.name).map((n) => [n.namespaceInfo!.name as string, n]),
    );

    const searchAttrCache = new Map<string, SearchAttributesResponse | Error>();
    const getSearchAttrs = async (ns: string): Promise<SearchAttributesResponse | Error> => {
      let cached = searchAttrCache.get(ns);
      if (!cached) {
        try {
          cached = await connection.operatorService.listSearchAttributes({ namespace: ns });
        } catch (err) {
          cached = err instanceof Error ? err : new Error(String(err));
        }
        searchAttrCache.set(ns, cached);
      }
      return cached;
    };

    for (const [entityName, { entityType, props }] of options.entities) {
      if (entityType === "Temporal::Namespace") {
        const name = props.name as string | undefined;
        const ns = name ? namespaceByName.get(name) : undefined;
        // Not deployed — the thin read already reports the absence (#1089);
        // restating it as a property hole here would turn one finding into two.
        if (!ns) continue;
        resources[entityName] = {
          type: entityType,
          physicalId: name,
          properties: normalizeDeepProperties(buildNamespaceProperties(ns, props), {
            entityType,
            side: "live",
            hooks: temporalDeepNormalizationHooks,
          }),
        };
        continue;
      }

      if (entityType === "Temporal::SearchAttribute") {
        const attrName = props.name as string | undefined;
        const ns = (props.namespace as string | undefined) ?? idx.defaultNamespace;
        if (!attrName || !ns) continue;
        const sa = await getSearchAttrs(ns);
        if (sa instanceof Error) {
          unobserved[entityName] = {
            type: entityType,
            reason: "read-failed",
            detail: `listSearchAttributes failed for namespace "${ns}": ${sa.message}`,
          };
          continue;
        }
        const valueType = sa.customAttributes?.[attrName];
        if (valueType === undefined) continue; // not registered — an absence, not a hole
        resources[entityName] = {
          type: entityType,
          physicalId: `${ns}/${attrName}`,
          properties: normalizeDeepProperties(
            { name: attrName, type: valueTypeToString(valueType), namespace: ns },
            { entityType, side: "live", hooks: temporalDeepNormalizationHooks },
          ),
        };
        continue;
      }

      if (entityType === "Temporal::Schedule") {
        const scheduleId = props.scheduleId as string | undefined;
        const ns = (props.namespace as string | undefined) ?? idx.defaultNamespace ?? "default";
        if (!scheduleId) continue;
        try {
          const described = await client.scheduleClient.getHandle(scheduleId, { namespace: ns }).describe();
          resources[entityName] = {
            type: entityType,
            physicalId: `${ns}/${scheduleId}`,
            properties: normalizeDeepProperties(buildScheduleProperties(described, scheduleId, ns, props), {
              entityType,
              side: "live",
              hooks: temporalDeepNormalizationHooks,
            }),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A schedule that was never created is an absence, not a hole —
          // same "not-found proves nothing else" rule the thin path applies.
          if (/not.?found/i.test(message)) continue;
          unobserved[entityName] = {
            type: entityType,
            reason: "read-failed",
            detail: `schedule describe failed for "${scheduleId}" in namespace "${ns}": ${message}`,
          };
        }
        continue;
      }

      // Temporal::Server and Temporal::Op are out of this row's scope — the
      // epic's surface is namespaces, schedules and search attributes.
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `no deep reader for ${entityType}`,
      };
    }
  } finally {
    if (typeof connection.close === "function") {
      try {
        await connection.close();
      } catch {
        /* best-effort */
      }
    }
  }

  return deepObservation(resources, unobserved);
}
