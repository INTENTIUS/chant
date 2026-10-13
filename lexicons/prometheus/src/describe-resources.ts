/**
 * `describeResources()` for prometheus (#3371): is each declared rule group
 * loaded on the environment's ruler and is it healthy, and is each declared
 * Alertmanager entity in the config the environment's Alertmanager runs.
 *
 * Runs on core's observer harness. `bind()` resolves the ruler and the
 * Alertmanager (./api/bind.ts), each on its own, so a project with only rule
 * groups is not held up by having no Alertmanager. Verdicts:
 *
 * | Entity | Read | Absent when |
 * |---|---|---|
 * | `RuleGroup` on Mimir, Cortex, Loki | the config API's `/{namespace}/{group}`, in the namespace the profile gives the group | 404 |
 * | `RuleGroup` on a plain Prometheus | `/api/v1/rules`, by name (and rule file, when the profile names one) | not listed |
 * | `Receiver`, `TimeInterval` | the loaded Alertmanager config, by name | no entry of that name |
 * | `Route` | the loaded routing tree, by receiver and matchers | no route with both |
 * | `InhibitRule` | the loaded inhibit rules, by matchers and `equal` | no equal rule |
 * | `AlertmanagerSettings` | the loaded config | no config (Mimir: the tenant has none) |
 * | `ScrapeConfig`, `PrometheusConfig` | none: `prometheus.yml` is a file on disk | `unsupported-kind` |
 *
 * A group's health is from `/api/v1/rules` (./api/evaluated.ts): `health`
 * (`ok`, `err`, `unknown`), the first rule error, and how many alerts are
 * firing or pending. A failed health read leaves the group present with
 * `health: "unknown"` and the reason; presence is the config API's answer.
 * The Alertmanager's cluster status and version ride on its entities.
 *
 * Ownership: a rule group and an Alertmanager config carry no marker
 * (./serializer.ts), so every verdict is `unknown`, and an `owned: true`
 * read withholds them as `filtered`. What bounds chant on a ruler is the
 * namespace: groups are only read in the namespaces the profile declares
 * (./config.ts).
 */

import { createHash } from "node:crypto";
import type { ResourceMetadata } from "@intentius/chant/lexicon";
import {
  observeEntities,
  type DeclaredEntity,
  type DescribeResourcesResult,
  type EntityObservation,
  type ObserverAdapter,
} from "@intentius/chant/observation";
import { bindEndpoints, classifyPromFailure, type BindOptions, type BoundEndpoints } from "./api/bind";
import { PromApiError } from "./api/client";
import { groupHealth } from "./api/evaluated";
import type { AlertmanagerApi } from "./api/alertmanager";
import type { RulerApi } from "./api/ruler";
import { isUnresolvedTarget, namespaceOfGroup, type UnresolvedTarget } from "./config";
import { INHIBIT_RULE_TYPE, RECEIVER_TYPE, ROUTE_TYPE, SETTINGS_TYPE, TIME_INTERVAL_TYPE } from "./alertmanager";
import { RULE_GROUP_TYPE } from "./rules";
import { PROMETHEUS_CONFIG_TYPE, SCRAPE_CONFIG_TYPE } from "./prometheus-config";
import { loadPrometheusYaml, parseAlertmanagerDocument } from "./import/parser";
import { stripAlertmanagerDefaults } from "./import/alertmanager-live";
import type { AlertmanagerConfig, RouteConfig } from "./model";

export interface PrometheusObserveOptions extends Omit<BindOptions, "environment"> {
  environment: string;
  buildOutput?: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  owned?: boolean;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** What `unsupported-kind` says about `prometheus.yml` entities. */
export const PROMETHEUS_CONFIG_NOT_OBSERVED =
  "prometheus.yml is a file Prometheus reads from disk, not something its API serves for comparison; observe it through the lexicon that deploys it";

/** A failed read as the harness's per-entity verdict; anything else is rethrown for the harness to record. */
function unobservedFrom(err: unknown): EntityObservation {
  if (err instanceof PromApiError) return { unobserved: classifyPromFailure(err) };
  throw err;
}

function unbound(u: UnresolvedTarget): EntityObservation {
  return { unobserved: { reason: u.reason, detail: u.detail } };
}

const FILTERED_DETAIL = "carries no ownership marker, so an owned-only read cannot show it is chant's";

// ── rule groups ─────────────────────────────────────────────────────

async function healthAttributes(ruler: RulerApi, file: string | undefined, name: string): Promise<Json> {
  try {
    const groups = await ruler.evaluated();
    const g = groups.find((x) => x.name === name && (file === undefined || x.file === file));
    if (!g) return { health: "unknown", healthDetail: `the ruler does not report "${name}" in ${ruler.evaluatedPath} yet` };
    const h = groupHealth(g);
    return {
      health: h.health,
      ...(h.lastError ? { lastError: h.lastError } : {}),
      failing: h.failing,
      firing: h.firing,
      pending: h.pending,
    };
  } catch (err) {
    return { health: "unknown", healthDetail: classifyPromFailure(err).detail };
  }
}

async function observeRuleGroup(ruler: RulerApi, entity: DeclaredEntity, owned: boolean | undefined): Promise<EntityObservation> {
  const name = typeof entity.props.name === "string" ? entity.props.name : entity.name;
  if (ruler.target.kind === "prometheus") {
    const file = namespaceOfGroup(ruler.target, name);
    let groups;
    try {
      groups = await ruler.evaluated();
    } catch (err) {
      return unobservedFrom(err);
    }
    const queried = ruler.evaluatedPath;
    const g = groups.find((x) => x.name === name && (file === undefined || x.file === file));
    if (!g) return { absent: true, queried };
    if (owned) return { unobserved: { reason: "filtered", detail: `rule group "${name}" is loaded but ${FILTERED_DETAIL}` }, queried };
    const h = groupHealth(g);
    return {
      present: {
        type: RULE_GROUP_TYPE,
        physicalId: `${g.file}/${name}`,
        status: "PRESENT",
        ownership: "unknown",
        attributes: {
          file: g.file,
          rules: g.rules.length,
          health: h.health,
          ...(h.lastError ? { lastError: h.lastError } : {}),
          failing: h.failing,
          firing: h.firing,
          pending: h.pending,
        },
      },
      queried,
    };
  }

  const namespace = namespaceOfGroup(ruler.target, name);
  if (namespace === undefined) {
    return { unobserved: { reason: "no-binding", detail: `${ruler.target.source} names no namespace for rule group "${name}"` } };
  }
  const queried = ruler.groupPath(namespace, name);
  let raw;
  try {
    raw = await ruler.readGroup(namespace, name);
  } catch (err) {
    return unobservedFrom(err);
  }
  if (!raw) return { absent: true, queried };
  if (owned) return { unobserved: { reason: "filtered", detail: `rule group "${name}" is in namespace "${namespace}" but ${FILTERED_DETAIL}` }, queried };
  const meta: ResourceMetadata = {
    type: RULE_GROUP_TYPE,
    physicalId: `${namespace}/${name}`,
    status: "PRESENT",
    ownership: "unknown",
    attributes: {
      namespace,
      rules: Array.isArray(raw.rules) ? raw.rules.length : 0,
      ...(typeof raw.interval === "string" ? { interval: raw.interval } : {}),
      ...(await healthAttributes(ruler, namespace, name)),
    },
  };
  return { present: meta, queried };
}

// ── Alertmanager ────────────────────────────────────────────────────

interface LoadedAlertmanager {
  config: AlertmanagerConfig;
  address: string;
  digest: string;
  health: Json;
}

async function loadAlertmanager(am: AlertmanagerApi): Promise<LoadedAlertmanager | undefined> {
  return am.client.once("observe:config", async () => {
    const live = await am.readConfig();
    if (!live) return undefined;
    const loaded = loadPrometheusYaml(live.text);
    if (!isObject(loaded)) throw new PromApiError(502, "GET", live.address, "the Alertmanager config is not a YAML mapping");
    const doc = live.remarshalled ? stripAlertmanagerDefaults(loaded) : loaded;
    const health = (await am.health()) ?? {};
    return {
      config: parseAlertmanagerDocument(doc).config,
      address: live.address,
      digest: createHash("sha256").update(live.text).digest("hex").slice(0, 16),
      health: { ...health },
    };
  });
}

/** `name="value"`, whatever spacing and quoting it was written with. */
function normalMatcher(m: string): string {
  const match = /^\s*([^=!~\s]+)\s*(=~|!~|!=|=)\s*(.*?)\s*$/.exec(m);
  if (!match) return m.trim();
  let value = match[3];
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  return `${match[1]}${match[2]}${JSON.stringify(value)}`;
}

function matcherKey(list: unknown): string {
  return (Array.isArray(list) ? list.map((m) => normalMatcher(String(m))) : []).sort().join(",");
}

function nameOf(ref: unknown): string | undefined {
  if (typeof ref === "string") return ref;
  if (isObject(ref) && isObject(ref.props) && typeof ref.props.name === "string") return ref.props.name;
  return undefined;
}

function routeKey(receiver: unknown, matchers: unknown): string {
  return `${nameOf(receiver) ?? ""}{${matcherKey(matchers)}}`;
}

function routesOf(root: RouteConfig | undefined): RouteConfig[] {
  if (!root) return [];
  const out: RouteConfig[] = [root];
  for (const child of root.routes ?? []) out.push(...routesOf(child));
  return out;
}

function inhibitKey(r: unknown): string {
  const rule = isObject(r) ? r : {};
  const equal = Array.isArray(rule.equal) ? [...rule.equal].map(String).sort().join(",") : "";
  return `${matcherKey(rule.source_matchers)}=>${matcherKey(rule.target_matchers)}/${equal}`;
}

async function observeAlertmanagerEntity(am: AlertmanagerApi, entity: DeclaredEntity, owned: boolean | undefined): Promise<EntityObservation> {
  let loaded;
  try {
    loaded = await loadAlertmanager(am);
  } catch (err) {
    return unobservedFrom(err);
  }
  const queried = am.target.kind === "alertmanager" ? am.statusPath : "/api/v1/alerts";
  if (!loaded) return { absent: true, queried };
  const { config, health } = loaded;
  const props = entity.props;

  let physicalId: string | undefined;
  let attributes: Json = {};
  switch (entity.type) {
    case RECEIVER_TYPE: {
      const r = (config.receivers ?? []).find((x) => x.name === props.name);
      if (r) {
        physicalId = `receiver/${r.name}`;
        attributes = { integrations: Object.keys(r).filter((k) => k.endsWith("_configs")).sort() };
      }
      break;
    }
    case TIME_INTERVAL_TYPE: {
      const t = (config.time_intervals ?? []).find((x) => x.name === props.name);
      if (t) physicalId = `time_interval/${t.name}`;
      break;
    }
    case ROUTE_TYPE: {
      const key = routeKey(props.receiver, props.matchers);
      const r = routesOf(config.route).find((x) => routeKey(x.receiver, x.matchers) === key);
      if (r) {
        physicalId = `route/${key}`;
        attributes = { receiver: r.receiver ?? "", routes: (r.routes ?? []).length };
      }
      break;
    }
    case INHIBIT_RULE_TYPE: {
      const key = inhibitKey(props);
      const i = (config.inhibit_rules ?? []).findIndex((x) => inhibitKey(x) === key);
      if (i >= 0) physicalId = `inhibit_rule/${i}`;
      break;
    }
    case SETTINGS_TYPE:
      physicalId = "alertmanager";
      attributes = { configDigest: loaded.digest, ...(config.templates ? { templates: config.templates.length } : {}) };
      break;
    default:
      return { unobserved: { reason: "unsupported-kind", detail: `no prometheus reader for ${entity.type}` } };
  }
  if (physicalId === undefined) return { absent: true, queried };
  if (owned) return { unobserved: { reason: "filtered", detail: `${entity.name} is in the loaded Alertmanager config but ${FILTERED_DETAIL}` }, queried };
  return {
    present: { type: entity.type, physicalId, status: "PRESENT", ownership: "unknown", attributes: { ...attributes, ...health } },
    queried,
  };
}

// ── harness ─────────────────────────────────────────────────────────

const ALERTMANAGER_TYPES = new Set([RECEIVER_TYPE, ROUTE_TYPE, INHIBIT_RULE_TYPE, TIME_INTERVAL_TYPE, SETTINGS_TYPE]);

function adapter(options: PrometheusObserveOptions): ObserverAdapter<BoundEndpoints> {
  return {
    bind: () => bindEndpoints({ ...options }),
    classifyBindFailure: (err) => classifyPromFailure(err),
    async read(endpoints, entity): Promise<EntityObservation> {
      if (entity.type === RULE_GROUP_TYPE) {
        return isUnresolvedTarget(endpoints.ruler) ? unbound(endpoints.ruler) : observeRuleGroup(endpoints.ruler, entity, options.owned);
      }
      if (ALERTMANAGER_TYPES.has(entity.type)) {
        return isUnresolvedTarget(endpoints.alertmanager)
          ? unbound(endpoints.alertmanager)
          : observeAlertmanagerEntity(endpoints.alertmanager, entity, options.owned);
      }
      if (entity.type === SCRAPE_CONFIG_TYPE || entity.type === PROMETHEUS_CONFIG_TYPE) {
        return { unobserved: { reason: "unsupported-kind", detail: PROMETHEUS_CONFIG_NOT_OBSERVED } };
      }
      return { unobserved: { reason: "unsupported-kind", detail: `no prometheus reader for ${entity.type}` } };
    },
  };
}

/** Observe every declared prometheus entity against the environment's ruler and Alertmanager. */
export async function describeResources(options: PrometheusObserveOptions): Promise<DescribeResourcesResult> {
  const declared: DeclaredEntity[] = [];
  for (const name of options.entityNames) {
    const entity = options.entities.get(name);
    if (!entity) continue;
    declared.push({ name, type: entity.entityType, props: entity.props });
  }
  return observeEntities(declared, adapter(options));
}
