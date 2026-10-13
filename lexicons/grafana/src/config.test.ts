import { describe, expect, it } from "vitest";
import { grafanaConfigSchema, resolveGrafanaTarget } from "./config";
import { namespaceOf } from "./api/client";
import { grafanaPlugin } from "./plugin";

const config = {
  grafana: {
    profiles: {
      prod: { url: "https://grafana.example.com/", token: { env: "GF_PROD" }, orgId: 2 },
      local: { url: "http://localhost:3000", basicAuth: { user: { env: "GF_USER" }, password: { env: "GF_PASS" } } },
    },
  },
};

describe("grafana config namespace", () => {
  it("is declared on the plugin and rejects an unknown key in a profile", () => {
    expect(grafanaPlugin.configSchema).toBe(grafanaConfigSchema);
    expect(grafanaConfigSchema.safeParse({ profiles: { prod: { url: "x", tokn: { env: "T" } } } }).success).toBe(false);
    expect(grafanaConfigSchema.safeParse(config.grafana).success).toBe(true);
  });
});

describe("resolveGrafanaTarget", () => {
  it("binds an environment's profile, with the token from the variable it names", () => {
    expect(resolveGrafanaTarget({ environment: "prod", config, env: { GF_PROD: "glsa_x" } })).toEqual({
      url: "https://grafana.example.com",
      auth: { token: "glsa_x" },
      orgId: 2,
      source: "grafana.profiles.prod",
    });
  });

  it("basic auth, from two variables", () => {
    expect(resolveGrafanaTarget({ environment: "local", config, env: { GF_USER: "admin", GF_PASS: "admin" } })).toMatchObject({ auth: { user: "admin", password: "admin" } });
  });

  it("a profile whose credential variable is unset is no-credentials, not an anonymous read", () => {
    expect(resolveGrafanaTarget({ environment: "prod", config, env: {} })).toEqual({ reason: "no-credentials", detail: expect.stringContaining("GF_PROD") });
    expect(resolveGrafanaTarget({ environment: "local", config, env: { GF_USER: "a" } })).toEqual({ reason: "no-credentials", detail: expect.stringContaining("GF_PASS") });
  });

  it("falls back to GRAFANA_URL and GRAFANA_TOKEN, or GRAFANA_USER and GRAFANA_PASSWORD", () => {
    expect(resolveGrafanaTarget({ environment: "dev", config, env: { GRAFANA_URL: "http://g:3000", GRAFANA_TOKEN: "t", GRAFANA_ORG_ID: "3" } })).toEqual({
      url: "http://g:3000",
      auth: { token: "t" },
      orgId: 3,
      source: "env GRAFANA_URL",
    });
    expect(resolveGrafanaTarget({ env: { GRAFANA_URL: "http://g", GRAFANA_USER: "u", GRAFANA_PASSWORD: "p" } })).toMatchObject({ auth: { user: "u", password: "p" } });
  });

  it("no profile and no GRAFANA_URL is no-binding", () => {
    expect(resolveGrafanaTarget({ environment: "dev", config, env: {} })).toEqual({ reason: "no-binding", detail: expect.stringContaining("grafana.profiles.dev") });
  });

  it("the dashboard API namespace follows the organisation", () => {
    expect(namespaceOf({})).toBe("default");
    expect(namespaceOf({ orgId: 4 })).toBe("org-4");
    expect(namespaceOf({ orgId: 4, namespace: "stacks-12" })).toBe("stacks-12");
  });
});
