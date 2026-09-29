/**
 * The `grafana` namespace in `chant.config.ts` (#2946): which Grafana each
 * chant environment observes, exports from and (#2948) applies to.
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 * import "@intentius/chant-lexicon-grafana";   // brings the `grafana` key into ChantConfig
 *
 * export default {
 *   lexicons: ["grafana"],
 *   grafana: {
 *     profiles: {
 *       staging: { url: "https://grafana.staging.example.com", token: { env: "GRAFANA_STAGING_TOKEN" } },
 *       prod: { url: "https://grafana.example.com", token: { env: "GRAFANA_PROD_TOKEN" }, orgId: 2 },
 *     },
 *   },
 * } satisfies ChantConfig;
 * ```
 *
 * A profile is keyed by chant environment, as `k8s.profiles.<env>` is.
 * Credentials are named by their environment variable, never written in
 * the config. An environment with no profile falls back to `GRAFANA_URL`
 * with `GRAFANA_TOKEN`, or `GRAFANA_USER` and `GRAFANA_PASSWORD` (see
 * `resolveGrafanaTarget`).
 *
 * One schema, three consumers, as in the fountain lexicon: core validates the
 * namespace against it at load, the type is derived from it, and that type
 * augments `ChantConfig`.
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";
import type { GrafanaAuth, GrafanaTarget } from "./api/client";

const envRef = z.strictObject({ env: z.string() });

export const grafanaProfileSchema = z.strictObject({
  /** Base URL of the Grafana instance. */
  url: z.string(),
  /** A service account token, named by its environment variable. */
  token: envRef.optional(),
  /** Basic auth, each half named by its environment variable. For a local instance; use a token elsewhere. */
  basicAuth: z.strictObject({ user: envRef, password: envRef }).optional(),
  /** Organisation id. Defaults to 1. */
  orgId: z.number().int().positive().optional(),
  /** The `dashboard.grafana.app` namespace, when it is not `default` / `org-<id>` (Grafana Cloud: `stacks-<id>`). */
  namespace: z.string().optional(),
});

export const grafanaConfigSchema = z.strictObject({
  /** One Grafana per chant environment. */
  profiles: z.record(z.string(), grafanaProfileSchema).optional(),
});

export type GrafanaProfile = z.infer<typeof grafanaProfileSchema>;
export type GrafanaConfig = z.infer<typeof grafanaConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    grafana?: GrafanaConfig;
  }
}

/** Compile-time proof that the augmentation reaches `ChantConfig`. */
export type GrafanaConfigNamespace = NonNullable<ChantConfig["grafana"]>;

/** Why no target could be resolved, in the observation vocabulary. */
export interface UnresolvedTarget {
  readonly reason: "no-binding" | "no-credentials";
  readonly detail: string;
}

function isUnresolved(v: GrafanaTarget | UnresolvedTarget): v is UnresolvedTarget {
  return "reason" in v;
}

export { isUnresolved as isUnresolvedTarget };

/**
 * The Grafana an environment reads from. Pure: `config` and `env` are
 * passed in.
 *
 * 1. `grafana.profiles.<environment>`. A profile that names a credential
 *    variable which is not set is `no-credentials`, not an anonymous read:
 *    the profile said how to authenticate.
 * 2. `GRAFANA_URL`, with `GRAFANA_TOKEN`, or `GRAFANA_USER` and
 *    `GRAFANA_PASSWORD`, or neither (an instance with anonymous access; a
 *    refused read is then `no-credentials`).
 * 3. Otherwise `no-binding`.
 */
export function resolveGrafanaTarget(input: {
  environment?: string;
  config?: Pick<ChantConfig, "grafana">;
  env?: Record<string, string | undefined>;
}): GrafanaTarget | UnresolvedTarget {
  const env = input.env ?? process.env;
  const profile = input.environment !== undefined ? input.config?.grafana?.profiles?.[input.environment] : undefined;
  if (profile) {
    const source = `grafana.profiles.${input.environment}`;
    let auth: GrafanaAuth | undefined;
    if (profile.token) {
      const token = env[profile.token.env];
      if (!token) return { reason: "no-credentials", detail: `${source}.token names ${profile.token.env}, which is not set` };
      auth = { token };
    } else if (profile.basicAuth) {
      const user = env[profile.basicAuth.user.env];
      const password = env[profile.basicAuth.password.env];
      if (!user || !password) {
        const missing = [!user ? profile.basicAuth.user.env : undefined, !password ? profile.basicAuth.password.env : undefined].filter(Boolean).join(" and ");
        return { reason: "no-credentials", detail: `${source}.basicAuth names ${missing}, which ${missing.includes(" and ") ? "are" : "is"} not set` };
      }
      auth = { user, password };
    }
    return {
      url: profile.url.replace(/\/+$/, ""),
      ...(auth ? { auth } : {}),
      ...(profile.orgId !== undefined ? { orgId: profile.orgId } : {}),
      ...(profile.namespace ? { namespace: profile.namespace } : {}),
      source,
    };
  }

  const url = env.GRAFANA_URL;
  if (!url) {
    const where = input.environment !== undefined ? `grafana.profiles.${input.environment} is not declared and ` : "";
    return { reason: "no-binding", detail: `${where}GRAFANA_URL is not set, so there is no Grafana to read` };
  }
  let auth: GrafanaAuth | undefined;
  if (env.GRAFANA_TOKEN) auth = { token: env.GRAFANA_TOKEN };
  else if (env.GRAFANA_USER && env.GRAFANA_PASSWORD) auth = { user: env.GRAFANA_USER, password: env.GRAFANA_PASSWORD };
  const orgId = env.GRAFANA_ORG_ID ? Number(env.GRAFANA_ORG_ID) : undefined;
  return {
    url: url.replace(/\/+$/, ""),
    ...(auth ? { auth } : {}),
    ...(orgId !== undefined && Number.isInteger(orgId) && orgId > 0 ? { orgId } : {}),
    source: "env GRAFANA_URL",
  };
}
