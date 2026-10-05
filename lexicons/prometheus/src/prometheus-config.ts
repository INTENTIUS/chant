/**
 * `PrometheusConfig` and `ScrapeConfig`: the entities that serialize to
 * `prometheus.yml`.
 *
 * A `ScrapeConfig` is one scrape job. `PrometheusConfig` holds the rest of the
 * file (`global`, `alerting`, `rule_files`, `remote_write`, `remote_read`,
 * `otlp`) and is optional: a build that declares only `ScrapeConfig`s still
 * writes a `prometheus.yml`. A project that declares neither writes none, so
 * a project that builds only rule files sees no change.
 */

import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { PrometheusConfigSections, ScrapeJobConfig } from "./model";

export const SCRAPE_CONFIG_TYPE = "Prometheus::Config::ScrapeConfig";
export const PROMETHEUS_CONFIG_TYPE = "Prometheus::Config::PrometheusConfig";

type Ctor<P, E> = new (props: P) => E;

function entityClass<P, E>(entityType: string, className: string): Ctor<P, E> {
  const Base = createResource(entityType, "prometheus", {}) as unknown as (this: object, props: Record<string, unknown>) => void;
  const Cls = function (this: object, props: P) {
    Base.call(this, (props ?? {}) as unknown as Record<string, unknown>);
  };
  Object.defineProperty(Cls, "name", { value: className });
  return Cls as unknown as Ctor<P, E>;
}

// ── ScrapeConfig ────────────────────────────────────────────────────

export type ScrapeConfigProps = ScrapeJobConfig;

export interface ScrapeConfigEntity extends Declarable {
  readonly props: ScrapeConfigProps;
}

/**
 * One scrape job: where its targets come from (`static_configs` or a service
 * discovery list), how to scrape them, and how to relabel what comes back.
 */
export const ScrapeConfig = entityClass<ScrapeConfigProps, ScrapeConfigEntity>(SCRAPE_CONFIG_TYPE, "ScrapeConfig");

// ── PrometheusConfig ────────────────────────────────────────────────

export interface PrometheusConfigProps extends PrometheusConfigSections {
  /** Scrape jobs written inline, as plain objects. Merged with the declared `ScrapeConfig`s. */
  scrape_configs?: Array<ScrapeConfigEntity | ScrapeConfigProps>;
}

export interface PrometheusConfigEntity extends Declarable {
  readonly props: PrometheusConfigProps;
}

/** The sections of `prometheus.yml` other than the scrape jobs. Declare at most one. */
export const PrometheusConfig = entityClass<PrometheusConfigProps, PrometheusConfigEntity>(PROMETHEUS_CONFIG_TYPE, "PrometheusConfig");

// ── Guards ──────────────────────────────────────────────────────────

function isType<T>(type: string) {
  return (value: unknown): value is T =>
    typeof value === "object" && value !== null && (value as Declarable).entityType === type;
}

export const isScrapeConfig = isType<ScrapeConfigEntity>(SCRAPE_CONFIG_TYPE);
export const isPrometheusConfig = isType<PrometheusConfigEntity>(PROMETHEUS_CONFIG_TYPE);

/** True for an entity that goes into `prometheus.yml`. */
export function isPrometheusConfigEntity(value: unknown): boolean {
  return isScrapeConfig(value) || isPrometheusConfig(value);
}
