/**
 * The ruler APIs (#3371): Mimir's, Cortex's and Loki's rule group config
 * API, and the Prometheus-compatible `/api/v1/rules` every one of them (and
 * a plain Prometheus) serves with each group's evaluation state.
 *
 * | Kind | Config API (YAML) | Evaluated rules (JSON) |
 * |---|---|---|
 * | `mimir` | `<prefix>/config/v1/rules[/{namespace}[/{group}]]` | `<prefix>/api/v1/rules` |
 * | `cortex` | `/api/v1/rules[/{namespace}[/{group}]]` | `<prefix>/api/v1/rules` |
 * | `loki` | `/loki/api/v1/rules[/{namespace}[/{group}]]` | `/prometheus/api/v1/rules` |
 * | `prometheus` | none: rule files on disk | `/api/v1/rules` |
 *
 * `<prefix>` is `-http.prometheus-http-prefix`, `/prometheus` unless the
 * profile says otherwise. Mimir does not register Cortex's `/api/v1/rules`
 * config path. Every request carries the target's `X-Scope-OrgID`.
 *
 * The writes (`setGroup`, `deleteGroup`) are here for the ruler apply
 * target (#3372), which reuses this module through
 * `@intentius/chant-lexicon-prometheus/api`. Nothing here deletes a
 * namespace: an apply bounded by the declared namespaces deletes groups one
 * by one, and only inside {@link declaredNamespaces}.
 */

import { emitYaml } from "../build";
import type { RuleGroupConfig } from "../model";
import { loadPrometheusYaml } from "../import/parser";
import type { RulerTarget } from "../config";
import { PromApiError, type PromClient } from "./client";

type Json = Record<string, unknown>;

/** A rule group as the ruler's config API returns it: the rule-file shape, plus whatever the ruler adds (`source_tenants`, say). */
export type RawRuleGroup = Json & { name: string };

/** One rule as `/api/v1/rules` reports it. */
export interface EvaluatedRule {
  type: "alerting" | "recording";
  name: string;
  query: string;
  /** Seconds. Alerting rules only. */
  duration?: number;
  /** Seconds. Alerting rules only. */
  keepFiringFor?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  health?: "ok" | "err" | "unknown" | string;
  lastError?: string;
  /** `inactive`, `pending` or `firing`. Alerting rules only. */
  state?: string;
  lastEvaluation?: string;
  evaluationTime?: number;
}

/** One group as `/api/v1/rules` reports it. `file` is the rule file on a Prometheus, the namespace on a ruler. */
export interface EvaluatedGroup {
  name: string;
  file: string;
  /** Seconds. */
  interval?: number;
  limit?: number;
  rules: EvaluatedRule[];
  lastEvaluation?: string;
  evaluationTime?: number;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const enc = encodeURIComponent;

/** A bound ruler: the transport and the target it reaches. */
export class RulerApi {
  constructor(
    readonly client: PromClient,
    readonly target: RulerTarget,
  ) {}

  /** The base of the rule group config API, or undefined for a plain Prometheus, which has none. */
  get configPath(): string | undefined {
    switch (this.target.kind) {
      case "mimir":
        return `${this.target.prometheusPrefix}/config/v1/rules`;
      case "cortex":
        return "/api/v1/rules";
      case "loki":
        return "/loki/api/v1/rules";
      case "prometheus":
        return undefined;
    }
  }

  /** The Prometheus-compatible rules endpoint, with evaluation state. */
  get evaluatedPath(): string {
    return `${this.target.prometheusPrefix}/api/v1/rules`;
  }

  private requireConfigPath(): string {
    const p = this.configPath;
    if (p === undefined) throw new Error(`a plain Prometheus (${this.target.source}) has no rule group API; its groups come from rule files`);
    return p;
  }

  private parseNamespaces(text: string, path: string): Record<string, RawRuleGroup[]> {
    const doc = loadPrometheusYaml(text);
    if (!isObject(doc)) throw new PromApiError(502, "GET", path, "the answer is not a YAML mapping of namespaces to rule groups");
    const out: Record<string, RawRuleGroup[]> = {};
    for (const [ns, groups] of Object.entries(doc)) {
      out[ns] = (Array.isArray(groups) ? groups : []).filter((g): g is RawRuleGroup => isObject(g) && typeof g.name === "string");
    }
    return out;
  }

  /** Every namespace the tenant has, with its groups. A 404 (Mimir: "no rule groups found") is none. */
  async listNamespaces(): Promise<Record<string, RawRuleGroup[]>> {
    const path = this.requireConfigPath();
    const text = await this.client.getText(path);
    return text === undefined ? {} : this.parseNamespaces(text, path);
  }

  /** One namespace's groups; undefined when the ruler has no such namespace. */
  async readNamespace(namespace: string): Promise<RawRuleGroup[] | undefined> {
    const path = `${this.requireConfigPath()}/${enc(namespace)}`;
    const text = await this.client.getText(path);
    if (text === undefined) return undefined;
    return this.parseNamespaces(text, path)[namespace] ?? [];
  }

  /** The path {@link readGroup} reads, for `queried`. */
  groupPath(namespace: string, group: string): string {
    return `${this.requireConfigPath()}/${enc(namespace)}/${enc(group)}`;
  }

  /** One group; undefined when it is not there. */
  async readGroup(namespace: string, group: string): Promise<RawRuleGroup | undefined> {
    const path = this.groupPath(namespace, group);
    const text = await this.client.getText(path);
    if (text === undefined) return undefined;
    const doc = loadPrometheusYaml(text);
    if (!isObject(doc) || typeof doc.name !== "string") throw new PromApiError(502, "GET", path, "the answer is not a rule group");
    return doc as RawRuleGroup;
  }

  /** Create or replace one group in `namespace` (202 on Mimir, Cortex and Loki). */
  async setGroup(namespace: string, group: RuleGroupConfig | RawRuleGroup): Promise<void> {
    await this.client.send("POST", `${this.requireConfigPath()}/${enc(namespace)}`, { text: emitYaml(group), contentType: "application/yaml" });
  }

  /** Delete one group from `namespace`. */
  async deleteGroup(namespace: string, group: string): Promise<void> {
    await this.client.send("DELETE", this.groupPath(namespace, group));
  }

  /** Every group the ruler evaluates, with its health. Read once per client. */
  async evaluated(): Promise<EvaluatedGroup[]> {
    return this.client.once("evaluated", async () => {
      const path = this.evaluatedPath;
      const body = await this.client.getJson<{ status?: string; data?: { groups?: unknown[] } }>(path);
      if (body === undefined) throw new PromApiError(404, "GET", path, "the rules API is not served here");
      if (body.status !== undefined && body.status !== "success") throw new PromApiError(502, "GET", path, `status ${body.status}`);
      return (body.data?.groups ?? []).filter((g): g is EvaluatedGroup => isObject(g) && typeof g.name === "string").map((g) => ({
        ...g,
        file: typeof g.file === "string" ? g.file : "",
        rules: Array.isArray(g.rules) ? g.rules.filter(isObject) as unknown as EvaluatedRule[] : [],
      }));
    });
  }
}
