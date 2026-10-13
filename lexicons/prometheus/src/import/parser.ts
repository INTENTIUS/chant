/**
 * Rule file, `prometheus.yml` or `alertmanager.yml` -> `TemplateIR`, for `chant import`.
 *
 * Either file is one document whose parts name each other (a route names a
 * receiver and time intervals), so the IR carries the whole file as one
 * resource and the generator lays out the modules itself, turning those
 * names into imports of declared entities. Core splits an IR with more than
 * three resources into one generate() call per category and keeps only the
 * first file of each, which would lose the imports between a route and the
 * receivers it names.
 *
 * Values are carried as written: `*_file` credential paths, Go templates in
 * annotations and notifier fields, and literal credentials, which PROM001
 * then reports in the generated source. What the lexicon has no place for is
 * named in `warnings`. Two deprecated Alertmanager spellings are rewritten to
 * the ones Alertmanager treats the same way: `match` / `match_re` (and the
 * inhibit rules' `source_match*` / `target_match*`) become matcher strings,
 * and the top-level `mute_time_intervals` list joins `time_intervals`.
 */

import * as jsYaml from "js-yaml";
import type { TemplateIR, TemplateParser } from "@intentius/chant/import/parser";
import {
  ALERTMANAGER_GLOBAL_FIELDS,
  RECEIVER_INTEGRATIONS,
  looksLikeAlertmanagerConfig,
  looksLikePrometheusConfig,
  looksLikeRuleFile,
  PROMETHEUS_CONFIG_SECTIONS,
  type AlertmanagerConfig,
  type InhibitRuleConfig,
  type ReceiverConfig,
  type RouteConfig,
  type RuleConfig,
  type RuleFileConfig,
  type RuleGroupConfig,
  type PrometheusConfigFile,
  type ScrapeJobConfig,
  type TimeIntervalConfig,
} from "../model";
import { TYPED_SD_KINDS } from "../model";
import { PROMETHEUS_PIN } from "../pin";

/** The IR resource type for a whole rule file. */
export const RULE_FILE_RESOURCE_TYPE = "Prometheus::RuleFile";
/** The IR resource type for a whole `alertmanager.yml`. */
export const ALERTMANAGER_RESOURCE_TYPE = "Prometheus::Alertmanager::Config";

/** The IR resource type for a whole `prometheus.yml`. */
export const PROMETHEUS_RESOURCE_TYPE = "Prometheus::Config";

/** `properties` of the `Prometheus::Config` resource. */
export interface PrometheusResourceProperties {
  config: PrometheusConfigFile;
}

/** `properties` of the `Prometheus::RuleFile` resource. */
export interface RuleFileResourceProperties {
  file: RuleFileConfig;
}

/** `properties` of the `Prometheus::Alertmanager::Config` resource. */
export interface AlertmanagerResourceProperties {
  config: AlertmanagerConfig;
}

/** What the parser read. */
export type ParsedPrometheusFile =
  | { kind: "rules"; file: RuleFileConfig; warnings: string[] }
  | { kind: "alertmanager"; config: AlertmanagerConfig; warnings: string[] }
  | { kind: "prometheus"; config: PrometheusConfigFile; warnings: string[] };

// YAML 1.2 core types plus `<<` merge keys, which Alertmanager configs use to
// share notifier settings. The default schema would also turn an unquoted
// date into a Date, which neither Go loader does.
// js-yaml exports its built-in types at runtime; @types/js-yaml does not declare them.
const MERGE_TYPE = (jsYaml as unknown as { types: { merge: jsYaml.Type } }).types.merge;
const YAML_SCHEMA = jsYaml.CORE_SCHEMA.extend({ implicit: [MERGE_TYPE] });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A label set with every value a string, as Prometheus and Alertmanager read one. */
function labelSet(v: unknown, at: string, warnings: string[]): Record<string, string> | undefined {
  if (v === null || v === undefined) return undefined;
  if (!isPlainObject(v)) {
    warnings.push(`${at} is not a mapping; it is not carried`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) out[k] = x === null ? "" : String(x);
  return out;
}

function stringList(v: unknown, at: string, warnings: string[]): string[] | undefined {
  if (v === null || v === undefined) return undefined;
  if (!Array.isArray(v)) {
    warnings.push(`${at} is not a list; it is not carried`);
    return undefined;
  }
  return v.map((x) => String(x));
}

// ── rule files ──────────────────────────────────────────────────────

const GROUP_KEYS = ["name", "interval", "query_offset", "limit", "labels", "rules"];
const RULE_KEYS = ["record", "alert", "expr", "for", "keep_firing_for", "labels", "annotations"];

function parseRule(raw: unknown, at: string, warnings: string[]): RuleConfig | undefined {
  if (!isPlainObject(raw)) {
    warnings.push(`${at} is not a mapping; it is not carried`);
    return undefined;
  }
  for (const k of Object.keys(raw)) {
    if (!RULE_KEYS.includes(k)) warnings.push(`${at}.${k} is not a rule field; it is not carried`);
  }
  const out: Record<string, unknown> = {};
  for (const k of ["record", "alert", "expr", "for", "keep_firing_for"]) {
    const v = raw[k];
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  const labels = labelSet(raw.labels, `${at}.labels`, warnings);
  if (labels) out.labels = labels;
  const annotations = labelSet(raw.annotations, `${at}.annotations`, warnings);
  if (annotations) out.annotations = annotations;
  return out as unknown as RuleConfig;
}

function parseRuleFile(doc: Record<string, unknown>, warnings: string[]): RuleFileConfig {
  for (const k of Object.keys(doc)) {
    if (k !== "groups") warnings.push(`top-level key "${k}" is not part of a rule file; it is not carried`);
  }
  const groups: RuleGroupConfig[] = [];
  const list = Array.isArray(doc.groups) ? doc.groups : [];
  list.forEach((raw, i) => {
    const at = `groups[${i}]`;
    if (!isPlainObject(raw)) {
      warnings.push(`${at} is not a mapping; it is not carried`);
      return;
    }
    const name = String(raw.name ?? "");
    const where = `group "${name}"`;
    for (const k of Object.keys(raw)) {
      if (!GROUP_KEYS.includes(k)) warnings.push(`${where}: "${k}" is not a rule group field; it is not carried`);
    }
    const group: Record<string, unknown> = { name };
    if (raw.interval !== undefined && raw.interval !== null) group.interval = String(raw.interval);
    if (raw.query_offset !== undefined && raw.query_offset !== null) group.query_offset = String(raw.query_offset);
    if (raw.limit !== undefined && raw.limit !== null) group.limit = Number(raw.limit);
    const labels = labelSet(raw.labels, `${where} labels`, warnings);
    if (labels) group.labels = labels;
    const rules: RuleConfig[] = [];
    (Array.isArray(raw.rules) ? raw.rules : []).forEach((r, j) => {
      const rule = parseRule(r, `${where} rules[${j}]`, warnings);
      if (rule) rules.push(rule);
    });
    group.rules = rules;
    groups.push(group as unknown as RuleGroupConfig);
  });
  return { groups };
}

// ── alertmanager.yml ────────────────────────────────────────────────

const AM_SECTIONS = ["global", "templates", "route", "inhibit_rules", "receivers", "time_intervals", "mute_time_intervals", "tracing"];
const ROUTE_KEYS = [
  "receiver",
  "group_by",
  "continue",
  "matchers",
  "match",
  "match_re",
  "group_wait",
  "group_interval",
  "repeat_interval",
  "mute_time_intervals",
  "active_time_intervals",
  "labels",
  "routes",
];

/** A matcher string Alertmanager parses back to `name op value`. */
export function matcherString(name: string, op: "=" | "=~", value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `${name}${op}"${escaped}"`;
}

/** `match` and `match_re` maps as matcher strings, in the order written. */
function matchersFrom(match: unknown, matchRe: unknown, at: string, warnings: string[]): string[] {
  const out: string[] = [];
  for (const [value, op, key] of [
    [match, "=", "match"],
    [matchRe, "=~", "match_re"],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (!isPlainObject(value)) {
      warnings.push(`${at}.${key} is not a mapping; it is not carried`);
      continue;
    }
    for (const [k, v] of Object.entries(value)) out.push(matcherString(k, op, String(v)));
  }
  return out;
}

function parseRoute(raw: unknown, at: string, warnings: string[]): RouteConfig {
  if (!isPlainObject(raw)) {
    warnings.push(`${at} is not a mapping; it is carried as an empty route`);
    return {};
  }
  for (const k of Object.keys(raw)) {
    if (!ROUTE_KEYS.includes(k)) warnings.push(`${at}.${k} is not a route field; it is not carried`);
  }
  const out: RouteConfig = {};
  if (raw.receiver !== undefined && raw.receiver !== null) out.receiver = String(raw.receiver);
  const groupBy = stringList(raw.group_by, `${at}.group_by`, warnings);
  if (groupBy) out.group_by = groupBy;
  if (typeof raw.continue === "boolean") out.continue = raw.continue;
  const matchers = stringList(raw.matchers, `${at}.matchers`, warnings) ?? [];
  const converted = matchersFrom(raw.match, raw.match_re, at, warnings);
  if (converted.length > 0) {
    warnings.push(`${at}: match/match_re are written as matchers (${converted.join(", ")}), which Alertmanager treats the same way`);
  }
  if (matchers.length + converted.length > 0 || raw.matchers !== undefined) out.matchers = [...matchers, ...converted];
  for (const k of ["group_wait", "group_interval", "repeat_interval"] as const) {
    if (raw[k] !== undefined && raw[k] !== null) out[k] = String(raw[k]);
  }
  const mute = stringList(raw.mute_time_intervals, `${at}.mute_time_intervals`, warnings);
  if (mute) out.mute_time_intervals = mute;
  const active = stringList(raw.active_time_intervals, `${at}.active_time_intervals`, warnings);
  if (active) out.active_time_intervals = active;
  const labels = labelSet(raw.labels, `${at}.labels`, warnings);
  if (labels) out.labels = labels;
  if (Array.isArray(raw.routes)) out.routes = raw.routes.map((r, i) => parseRoute(r, `${at}.routes[${i}]`, warnings));
  else if (raw.routes !== undefined && raw.routes !== null) warnings.push(`${at}.routes is not a list; it is not carried`);
  return out;
}

function parseInhibitRule(raw: unknown, at: string, warnings: string[]): InhibitRuleConfig | undefined {
  if (!isPlainObject(raw)) {
    warnings.push(`${at} is not a mapping; it is not carried`);
    return undefined;
  }
  const known = ["name", "source_matchers", "source_match", "source_match_re", "target_matchers", "target_match", "target_match_re", "equal"];
  for (const k of Object.keys(raw)) {
    if (!known.includes(k)) warnings.push(`${at}.${k} is not an inhibit rule field; it is not carried`);
  }
  const out: InhibitRuleConfig = {};
  if (raw.name !== undefined && raw.name !== null) out.name = String(raw.name);
  for (const side of ["source", "target"] as const) {
    const matchers = stringList(raw[`${side}_matchers`], `${at}.${side}_matchers`, warnings) ?? [];
    const converted = matchersFrom(raw[`${side}_match`], raw[`${side}_match_re`], at, warnings);
    if (converted.length > 0) {
      warnings.push(
        `${at}: ${side}_match/${side}_match_re are written as ${side}_matchers (${converted.join(", ")}), which Alertmanager treats the same way`,
      );
    }
    if (matchers.length + converted.length > 0 || raw[`${side}_matchers`] !== undefined) {
      out[`${side}_matchers`] = [...matchers, ...converted];
    }
  }
  const equal = stringList(raw.equal, `${at}.equal`, warnings);
  if (equal) out.equal = equal;
  return out;
}

function parseTimeIntervals(raw: unknown, at: string, warnings: string[]): TimeIntervalConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`${at} is not a list; it is not carried`);
    return [];
  }
  const out: TimeIntervalConfig[] = [];
  raw.forEach((t, i) => {
    if (!isPlainObject(t) || typeof t.name !== "string") {
      warnings.push(`${at}[${i}] has no name; it is not carried`);
      return;
    }
    out.push({ name: t.name, time_intervals: (Array.isArray(t.time_intervals) ? t.time_intervals : []) as TimeIntervalConfig["time_intervals"] });
  });
  return out;
}

const AM_VERSION = PROMETHEUS_PIN.alertmanager.version;
const RECEIVER_KEYS = new Set<string>(["name", "labels", ...RECEIVER_INTEGRATIONS]);
const GLOBAL_KEYS = new Set<string>(ALERTMANAGER_GLOBAL_FIELDS);

function parseAlertmanager(doc: Record<string, unknown>, warnings: string[]): AlertmanagerConfig {
  for (const k of Object.keys(doc)) {
    if (!AM_SECTIONS.includes(k)) warnings.push(`top-level section "${k}" is not one chant declares; it is not carried`);
  }
  const config: AlertmanagerConfig = {};
  if (isPlainObject(doc.global)) {
    config.global = doc.global as AlertmanagerConfig["global"];
    const unknown = Object.keys(doc.global).filter((k) => !GLOBAL_KEYS.has(k));
    if (unknown.length > 0) {
      warnings.push(`global: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a global field" : "are not global fields"} in Alertmanager ${AM_VERSION}; carried as data, untyped`);
    }
  }
  else if (doc.global !== undefined && doc.global !== null) warnings.push("global is not a mapping; it is not carried");
  const templates = stringList(doc.templates, "templates", warnings);
  if (templates) config.templates = templates;
  if (doc.route !== undefined && doc.route !== null) config.route = parseRoute(doc.route, "route", warnings);
  if (Array.isArray(doc.inhibit_rules)) {
    config.inhibit_rules = doc.inhibit_rules
      .map((r, i) => parseInhibitRule(r, `inhibit_rules[${i}]`, warnings))
      .filter((r): r is InhibitRuleConfig => r !== undefined);
  } else if (doc.inhibit_rules !== undefined && doc.inhibit_rules !== null) {
    warnings.push("inhibit_rules is not a list; it is not carried");
  }
  if (Array.isArray(doc.receivers)) {
    const receivers: ReceiverConfig[] = [];
    doc.receivers.forEach((r, i) => {
      if (!isPlainObject(r) || r.name === undefined || r.name === null) {
        warnings.push(`receivers[${i}] has no name; it is not carried`);
        return;
      }
      const unknown = Object.keys(r).filter((k) => !RECEIVER_KEYS.has(k));
      if (unknown.length > 0) {
        warnings.push(`receiver "${String(r.name)}": ${unknown.join(", ")} ${unknown.length === 1 ? "is not a receiver field" : "are not receiver fields"} in Alertmanager ${AM_VERSION}; carried as data, untyped`);
      }
      receivers.push({ ...r, name: String(r.name) } as ReceiverConfig);
    });
    config.receivers = receivers;
  } else if (doc.receivers !== undefined && doc.receivers !== null) {
    warnings.push("receivers is not a list; it is not carried");
  }
  const intervals = parseTimeIntervals(doc.time_intervals, "time_intervals", warnings);
  const legacy = parseTimeIntervals(doc.mute_time_intervals, "mute_time_intervals", warnings);
  if (legacy.length > 0) {
    warnings.push(
      `the top-level mute_time_intervals (${legacy.map((t) => t.name).join(", ")}) are declared as TimeIntervals and written under time_intervals, which Alertmanager reads the same way`,
    );
  }
  if (intervals.length + legacy.length > 0) config.time_intervals = [...intervals, ...legacy];
  if (isPlainObject(doc.tracing)) config.tracing = doc.tracing as AlertmanagerConfig["tracing"];
  else if (doc.tracing !== undefined && doc.tracing !== null) warnings.push("tracing is not a mapping; it is not carried");
  return config;
}

// ── prometheus.yml ──────────────────────────────────────────────────

function parsePrometheusConfig(doc: Record<string, unknown>, warnings: string[]): PrometheusConfigFile {
  const config: Record<string, unknown> = {};
  for (const k of Object.keys(doc)) {
    if (!PROMETHEUS_CONFIG_SECTIONS.includes(k)) warnings.push(`top-level section "${k}" is not one Prometheus ${PROM_VERSION} defines; it is not carried`);
  }
  const jobNames = new Set<string>();
  for (const key of PROMETHEUS_CONFIG_SECTIONS) {
    const v = doc[key];
    if (v === undefined || v === null) continue;
    if (key === "rule_files" || key === "scrape_config_files") {
      const list = stringList(v, key, warnings);
      if (list) config[key] = list;
    } else if (key === "scrape_configs") {
      if (!Array.isArray(v)) {
        warnings.push("scrape_configs is not a list; it is not carried");
        continue;
      }
      const jobs: ScrapeJobConfig[] = [];
      v.forEach((raw, i) => {
        if (!isPlainObject(raw) || typeof raw.job_name !== "string") {
          warnings.push(`scrape_configs[${i}] has no job_name; it is not carried`);
          return;
        }
        if (jobNames.has(raw.job_name)) warnings.push(`scrape_configs: job_name "${raw.job_name}" is used more than once; Prometheus rejects that`);
        jobNames.add(raw.job_name);
        const sd = Object.keys(raw).filter((k) => k.endsWith("_sd_configs") && !TYPED_SD_KINDS.includes(k));
        if (sd.length > 0) warnings.push(`job "${raw.job_name}": ${sd.join(", ")} ${sd.length === 1 ? "is" : "are"} carried as data, untyped`);
        jobs.push(raw as unknown as ScrapeJobConfig);
      });
      config.scrape_configs = jobs;
    } else if (key === "remote_write" || key === "remote_read") {
      if (Array.isArray(v)) config[key] = v;
      else warnings.push(`${key} is not a list; it is not carried`);
    } else if (isPlainObject(v)) {
      config[key] = v;
    } else {
      warnings.push(`${key} is not a mapping; it is not carried`);
    }
  }
  return config as PrometheusConfigFile;
}

const PROM_VERSION = PROMETHEUS_PIN.prometheus.version;

// ── entry points ────────────────────────────────────────────────────

/** Load YAML the way the parser does: YAML 1.2 core types plus `<<` merge keys. */
export function loadPrometheusYaml(content: string): unknown {
  return content.trim() === "" ? {} : jsYaml.load(content, { schema: YAML_SCHEMA });
}

/** A rule file already loaded (live import builds one from a ruler's groups, ../export-resources.ts). */
export function parseRuleFileDocument(doc: Record<string, unknown>): { file: RuleFileConfig; warnings: string[] } {
  const warnings: string[] = [];
  return { file: parseRuleFile(doc, warnings), warnings };
}

/** An `alertmanager.yml` already loaded (live import reads one from Alertmanager's API, ../export-resources.ts). */
export function parseAlertmanagerDocument(doc: Record<string, unknown>): { config: AlertmanagerConfig; warnings: string[] } {
  const warnings: string[] = [];
  return { config: parseAlertmanager(doc, warnings), warnings };
}

/** Parse a rule file or `alertmanager.yml`, telling them apart by shape. */
export function parsePrometheusYaml(content: string): ParsedPrometheusFile {
  const warnings: string[] = [];
  const doc = loadPrometheusYaml(content);
  if (!isPlainObject(doc)) {
    throw new Error("a Prometheus rule file, alertmanager.yml or prometheus.yml is a YAML mapping; this document is not one");
  }
  if (looksLikeRuleFile(doc)) return { kind: "rules", file: parseRuleFile(doc, warnings), warnings };
  if (looksLikeAlertmanagerConfig(doc)) return { kind: "alertmanager", config: parseAlertmanager(doc, warnings), warnings };
  if (looksLikePrometheusConfig(doc)) return { kind: "prometheus", config: parsePrometheusConfig(doc, warnings), warnings };
  if ("groups" in doc) {
    // A rule file with a malformed group still imports; the bad parts are named.
    return { kind: "rules", file: parseRuleFile(doc, warnings), warnings };
  }
  throw new Error(
    "this YAML is not a Prometheus rule file (groups: of named rule lists), an alertmanager.yml (route: or receivers:) or a prometheus.yml (scrape_configs: and the like)",
  );
}

/** The rule file and `alertmanager.yml` parser `chant import` runs. */
export class PrometheusParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const parsed = parsePrometheusYaml(content);
    const resource =
      parsed.kind === "prometheus"
        ? {
            logicalId: "prometheus",
            type: PROMETHEUS_RESOURCE_TYPE,
            properties: { config: parsed.config } satisfies PrometheusResourceProperties as unknown as Record<string, unknown>,
          }
        : parsed.kind === "rules"
        ? {
            logicalId: "ruleFile",
            type: RULE_FILE_RESOURCE_TYPE,
            properties: { file: parsed.file } satisfies RuleFileResourceProperties as unknown as Record<string, unknown>,
          }
        : {
            logicalId: "alertmanager",
            type: ALERTMANAGER_RESOURCE_TYPE,
            properties: { config: parsed.config } satisfies AlertmanagerResourceProperties as unknown as Record<string, unknown>,
          };
    return { resources: [resource], parameters: [], warnings: parsed.warnings };
  }
}
