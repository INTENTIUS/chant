/**
 * The `prometheus` namespace in `chant.config.ts` (#3371): which ruler and
 * which Alertmanager each chant environment observes and imports from, and
 * (#3372) applies to.
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 * import "@intentius/chant-lexicon-prometheus";   // brings the `prometheus` key into ChantConfig
 *
 * export default {
 *   lexicons: ["prometheus"],
 *   prometheus: {
 *     profiles: {
 *       prod: {
 *         ruler: { kind: "mimir", url: "https://mimir.example.com", tenant: "shop", namespace: "shop-rules", token: { env: "MIMIR_TOKEN" } },
 *         alertmanager: { kind: "mimir", url: "https://mimir.example.com", tenant: "shop", token: { env: "MIMIR_TOKEN" } },
 *       },
 *     },
 *   },
 * } satisfies ChantConfig;
 * ```
 *
 * A rule file has no namespace and no ownership marker, so the ruler
 * namespaces a profile names are the boundary: `namespace` is where the
 * project's groups live, `groupNamespaces` moves single groups to another,
 * and nothing outside those namespaces is read for import or written by an
 * apply. On a plain Prometheus the "namespace" is the rule file path
 * `/api/v1/rules` reports as `file`, and may be left out.
 *
 * Credentials are named by their environment variable, never written in the
 * config. An environment with no profile falls back to environment
 * variables (see {@link resolveRulerTarget} and
 * {@link resolveAlertmanagerTarget}).
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";
import type { PromAuth, PromTarget } from "./api/client";

const envRef = z.strictObject({ env: z.string() });
const basicAuth = z.strictObject({ user: envRef, password: envRef });

/** The rulers chant reads rule groups from. `prometheus` is a plain Prometheus, read over `/api/v1/rules`. */
export const RULER_KINDS = ["mimir", "cortex", "loki", "prometheus"] as const;
export type RulerKind = (typeof RULER_KINDS)[number];

/** Where an Alertmanager config is read: a plain Alertmanager's `/api/v2/status`, or Mimir's and Cortex's `/api/v1/alerts`. */
export const ALERTMANAGER_KINDS = ["alertmanager", "mimir", "cortex"] as const;
export type AlertmanagerKind = (typeof ALERTMANAGER_KINDS)[number];

export const rulerProfileSchema = z.strictObject({
  kind: z.enum(RULER_KINDS),
  /** Base URL: the Mimir, Cortex or Loki endpoint the ruler API is served on, or the Prometheus server. */
  url: z.string(),
  /** `X-Scope-OrgID`. */
  tenant: z.string().optional(),
  /** The ruler namespace the project's rule groups live in (on a plain Prometheus, the rule file path). */
  namespace: z.string().optional(),
  /** Groups that live in another namespace than `namespace`, by group name. */
  groupNamespaces: z.record(z.string(), z.string()).optional(),
  /** Mimir's or Cortex's `-http.prometheus-http-prefix`. Defaults to `/prometheus` (to nothing for a plain Prometheus). */
  prometheusPrefix: z.string().optional(),
  token: envRef.optional(),
  basicAuth: basicAuth.optional(),
});

export const alertmanagerProfileSchema = z.strictObject({
  kind: z.enum(ALERTMANAGER_KINDS).optional(),
  url: z.string(),
  /** `X-Scope-OrgID`, for Mimir and Cortex. */
  tenant: z.string().optional(),
  /** Mimir's or Cortex's `-http.alertmanager-http-prefix`. Defaults to `/alertmanager`. */
  alertmanagerPrefix: z.string().optional(),
  token: envRef.optional(),
  basicAuth: basicAuth.optional(),
});

export const prometheusProfileSchema = z.strictObject({
  ruler: rulerProfileSchema.optional(),
  alertmanager: alertmanagerProfileSchema.optional(),
});

export const prometheusConfigSchema = z.strictObject({
  /** One ruler and one Alertmanager per chant environment. */
  profiles: z.record(z.string(), prometheusProfileSchema).optional(),
});

export type RulerProfile = z.infer<typeof rulerProfileSchema>;
export type AlertmanagerProfile = z.infer<typeof alertmanagerProfileSchema>;
export type PrometheusProfile = z.infer<typeof prometheusProfileSchema>;
export type PrometheusLexiconConfig = z.infer<typeof prometheusConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    prometheus?: PrometheusLexiconConfig;
  }
}

/** Compile-time proof that the augmentation reaches `ChantConfig`. */
export type PrometheusConfigNamespace = NonNullable<ChantConfig["prometheus"]>;

/** Why no target could be resolved, in the observation vocabulary. */
export interface UnresolvedTarget {
  readonly reason: "no-binding" | "no-credentials";
  readonly detail: string;
}

export function isUnresolvedTarget(v: object): v is UnresolvedTarget {
  return "reason" in v;
}

/** A resolved ruler. */
export interface RulerTarget extends PromTarget {
  readonly kind: RulerKind;
  /** Where the project's groups live; absent only for an ad-hoc read with no namespace named. */
  readonly namespace?: string;
  readonly groupNamespaces: Readonly<Record<string, string>>;
  readonly prometheusPrefix: string;
}

/** A resolved Alertmanager. */
export interface AlertmanagerTarget extends PromTarget {
  readonly kind: AlertmanagerKind;
  readonly alertmanagerPrefix: string;
}

/**
 * The namespaces a ruler target declares, deduplicated, in the order they
 * are named. This is the ownership boundary: import reads only these, and
 * an apply (#3372) writes and deletes only inside these.
 */
export function declaredNamespaces(target: Pick<RulerTarget, "namespace" | "groupNamespaces">): string[] {
  const out: string[] = [];
  for (const ns of [target.namespace, ...Object.values(target.groupNamespaces)]) {
    if (ns !== undefined && ns !== "" && !out.includes(ns)) out.push(ns);
  }
  return out;
}

/** The namespace a declared group lives in: its `groupNamespaces` entry, else `namespace`. */
export function namespaceOfGroup(target: Pick<RulerTarget, "namespace" | "groupNamespaces">, group: string): string | undefined {
  return target.groupNamespaces[group] ?? target.namespace;
}

type Env = Record<string, string | undefined>;

function profileAuth(
  source: string,
  profile: { token?: { env: string }; basicAuth?: { user: { env: string }; password: { env: string } } },
  env: Env,
): PromAuth | undefined | UnresolvedTarget {
  if (profile.token) {
    const token = env[profile.token.env];
    if (!token) return { reason: "no-credentials", detail: `${source}.token names ${profile.token.env}, which is not set` };
    return { token };
  }
  if (profile.basicAuth) {
    const user = env[profile.basicAuth.user.env];
    const password = env[profile.basicAuth.password.env];
    if (!user || !password) {
      const missing = [!user ? profile.basicAuth.user.env : undefined, !password ? profile.basicAuth.password.env : undefined].filter(Boolean).join(" and ");
      return { reason: "no-credentials", detail: `${source}.basicAuth names ${missing}, which ${missing.includes(" and ") ? "are" : "is"} not set` };
    }
    return { user, password };
  }
  return undefined;
}

function envAuth(env: Env, prefix: string): PromAuth | undefined {
  const token = env[`${prefix}_TOKEN`];
  if (token) return { token };
  const user = env[`${prefix}_USER`];
  const password = env[`${prefix}_PASSWORD`];
  return user && password ? { user, password } : undefined;
}

const trim = (url: string) => url.replace(/\/+$/, "");
const prefixOf = (p: string | undefined, fallback: string) => (p === undefined ? fallback : p === "" ? "" : `/${p.replace(/^\/+|\/+$/g, "")}`);

interface ResolveInput {
  environment?: string;
  config?: Pick<ChantConfig, "prometheus">;
  env?: Env;
}

/**
 * The ruler an environment reads from. Pure: `config` and `env` are passed in.
 *
 * 1. `prometheus.profiles.<environment>.ruler`. A profile that names a
 *    credential variable which is not set is `no-credentials`.
 * 2. `PROMETHEUS_RULER_URL`, with `PROMETHEUS_RULER_KIND` (default `mimir`),
 *    `PROMETHEUS_RULER_TENANT`, `PROMETHEUS_RULER_NAMESPACE` and
 *    `PROMETHEUS_RULER_TOKEN` (or `_USER` and `_PASSWORD`).
 * 3. `PROMETHEUS_URL`: a plain Prometheus, read over `/api/v1/rules`.
 * 4. Otherwise `no-binding`.
 */
export function resolveRulerTarget(input: ResolveInput): RulerTarget | UnresolvedTarget {
  const env = input.env ?? process.env;
  const profile = input.environment !== undefined ? input.config?.prometheus?.profiles?.[input.environment]?.ruler : undefined;
  if (profile) {
    const source = `prometheus.profiles.${input.environment}.ruler`;
    const auth = profileAuth(source, profile, env);
    if (auth && isUnresolvedTarget(auth)) return auth;
    if (profile.kind !== "prometheus" && !profile.namespace) {
      return { reason: "no-binding", detail: `${source}.namespace is not set, and a ${profile.kind} ruler's groups live in a namespace` };
    }
    return {
      kind: profile.kind,
      url: trim(profile.url),
      ...(profile.tenant ? { tenant: profile.tenant } : {}),
      ...(auth ? { auth } : {}),
      ...(profile.namespace ? { namespace: profile.namespace } : {}),
      groupNamespaces: profile.groupNamespaces ?? {},
      prometheusPrefix: prefixOf(profile.prometheusPrefix, profile.kind === "prometheus" ? "" : "/prometheus"),
      source,
    };
  }

  const where = input.environment !== undefined ? `prometheus.profiles.${input.environment}.ruler is not declared and ` : "";
  const rulerUrl = env.PROMETHEUS_RULER_URL;
  if (rulerUrl) {
    const kind = (env.PROMETHEUS_RULER_KIND ?? "mimir") as RulerKind;
    if (!RULER_KINDS.includes(kind)) {
      return { reason: "no-binding", detail: `PROMETHEUS_RULER_KIND is "${kind}", not one of ${RULER_KINDS.join(", ")}` };
    }
    const auth = envAuth(env, "PROMETHEUS_RULER");
    return {
      kind,
      url: trim(rulerUrl),
      ...(env.PROMETHEUS_RULER_TENANT ? { tenant: env.PROMETHEUS_RULER_TENANT } : {}),
      ...(auth ? { auth } : {}),
      ...(env.PROMETHEUS_RULER_NAMESPACE ? { namespace: env.PROMETHEUS_RULER_NAMESPACE } : {}),
      groupNamespaces: {},
      prometheusPrefix: "/prometheus",
      source: "env PROMETHEUS_RULER_URL",
    };
  }
  const promUrl = env.PROMETHEUS_URL;
  if (promUrl) {
    const auth = envAuth(env, "PROMETHEUS");
    return { kind: "prometheus", url: trim(promUrl), ...(auth ? { auth } : {}), groupNamespaces: {}, prometheusPrefix: "", source: "env PROMETHEUS_URL" };
  }
  return { reason: "no-binding", detail: `${where}neither PROMETHEUS_RULER_URL nor PROMETHEUS_URL is set, so there is no ruler to read` };
}

/**
 * The Alertmanager an environment reads from. Pure.
 *
 * 1. `prometheus.profiles.<environment>.alertmanager`.
 * 2. `ALERTMANAGER_URL`, with `ALERTMANAGER_KIND` (default `alertmanager`),
 *    `ALERTMANAGER_TENANT` and `ALERTMANAGER_TOKEN` (or `_USER` and `_PASSWORD`).
 * 3. Otherwise `no-binding`.
 */
export function resolveAlertmanagerTarget(input: ResolveInput): AlertmanagerTarget | UnresolvedTarget {
  const env = input.env ?? process.env;
  const profile = input.environment !== undefined ? input.config?.prometheus?.profiles?.[input.environment]?.alertmanager : undefined;
  if (profile) {
    const source = `prometheus.profiles.${input.environment}.alertmanager`;
    const auth = profileAuth(source, profile, env);
    if (auth && isUnresolvedTarget(auth)) return auth;
    return {
      kind: profile.kind ?? "alertmanager",
      url: trim(profile.url),
      ...(profile.tenant ? { tenant: profile.tenant } : {}),
      ...(auth ? { auth } : {}),
      alertmanagerPrefix: prefixOf(profile.alertmanagerPrefix, "/alertmanager"),
      source,
    };
  }
  const url = env.ALERTMANAGER_URL;
  if (!url) {
    const where = input.environment !== undefined ? `prometheus.profiles.${input.environment}.alertmanager is not declared and ` : "";
    return { reason: "no-binding", detail: `${where}ALERTMANAGER_URL is not set, so there is no Alertmanager to read` };
  }
  const kind = (env.ALERTMANAGER_KIND ?? "alertmanager") as AlertmanagerKind;
  if (!ALERTMANAGER_KINDS.includes(kind)) {
    return { reason: "no-binding", detail: `ALERTMANAGER_KIND is "${kind}", not one of ${ALERTMANAGER_KINDS.join(", ")}` };
  }
  const auth = envAuth(env, "ALERTMANAGER");
  return {
    kind,
    url: trim(url),
    ...(env.ALERTMANAGER_TENANT ? { tenant: env.ALERTMANAGER_TENANT } : {}),
    ...(auth ? { auth } : {}),
    alertmanagerPrefix: "/alertmanager",
    source: "env ALERTMANAGER_URL",
  };
}
