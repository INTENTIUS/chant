/** `prometheus.profiles.<env>`: the schema, the target resolution and the namespace boundary (#3371). */

import { describe, expect, test } from "vitest";
import {
  declaredNamespaces,
  namespaceOfGroup,
  prometheusConfigSchema,
  resolveAlertmanagerTarget,
  resolveRulerTarget,
  type RulerTarget,
} from "./config";
import { prometheusPlugin } from "./plugin";

const config = {
  prometheus: {
    profiles: {
      prod: {
        ruler: { kind: "mimir" as const, url: "https://mimir.example.com/", tenant: "shop", namespace: "shop", groupNamespaces: { infra: "platform" }, token: { env: "MIMIR_TOKEN" } },
        alertmanager: { kind: "mimir" as const, url: "https://mimir.example.com", tenant: "shop" },
      },
      bare: { ruler: { kind: "loki" as const, url: "http://loki:3100" } },
      prom: { ruler: { kind: "prometheus" as const, url: "http://prometheus:9090" } },
    },
  },
};

describe("prometheusConfigSchema", () => {
  test("is the plugin's config schema and accepts the documented profile", () => {
    expect(prometheusPlugin.configSchema).toBe(prometheusConfigSchema);
    expect(prometheusConfigSchema.safeParse(config.prometheus).success).toBe(true);
  });

  test("refuses an unknown key and an unknown ruler kind", () => {
    expect(prometheusConfigSchema.safeParse({ profiles: { prod: { ruler: { kind: "mimir", url: "x", namespce: "typo" } } } }).success).toBe(false);
    expect(prometheusConfigSchema.safeParse({ profiles: { prod: { ruler: { kind: "thanos", url: "x" } } } }).success).toBe(false);
  });
});

describe("resolveRulerTarget", () => {
  test("a profile resolves with its tenant, namespaces, token and the default prefix", () => {
    const t = resolveRulerTarget({ environment: "prod", config, env: { MIMIR_TOKEN: "t0k" } }) as RulerTarget;
    expect(t).toMatchObject({
      kind: "mimir",
      url: "https://mimir.example.com",
      tenant: "shop",
      namespace: "shop",
      auth: { token: "t0k" },
      prometheusPrefix: "/prometheus",
      source: "prometheus.profiles.prod.ruler",
    });
  });

  test("a token variable that is not set is no-credentials, not an anonymous read", () => {
    expect(resolveRulerTarget({ environment: "prod", config, env: {} })).toEqual({
      reason: "no-credentials",
      detail: "prometheus.profiles.prod.ruler.token names MIMIR_TOKEN, which is not set",
    });
  });

  test("a Mimir, Cortex or Loki profile with no namespace is no-binding; a Prometheus one needs none and has no prefix", () => {
    expect(resolveRulerTarget({ environment: "bare", config, env: {} })).toMatchObject({ reason: "no-binding" });
    expect(resolveRulerTarget({ environment: "prom", config, env: {} })).toMatchObject({ kind: "prometheus", prometheusPrefix: "" });
  });

  test("with no profile, PROMETHEUS_RULER_URL and then PROMETHEUS_URL bind, and neither is no-binding", () => {
    expect(
      resolveRulerTarget({ environment: "dev", config, env: { PROMETHEUS_RULER_URL: "http://cortex", PROMETHEUS_RULER_KIND: "cortex", PROMETHEUS_RULER_TENANT: "t" } }),
    ).toMatchObject({ kind: "cortex", url: "http://cortex", tenant: "t", source: "env PROMETHEUS_RULER_URL" });
    expect(resolveRulerTarget({ environment: "dev", config, env: { PROMETHEUS_URL: "http://p:9090" } })).toMatchObject({ kind: "prometheus", source: "env PROMETHEUS_URL" });
    expect(resolveRulerTarget({ environment: "dev", config, env: {} })).toMatchObject({ reason: "no-binding" });
    expect(resolveRulerTarget({ environment: "dev", config, env: { PROMETHEUS_RULER_URL: "x", PROMETHEUS_RULER_KIND: "thanos" } })).toMatchObject({ reason: "no-binding" });
  });
});

describe("resolveAlertmanagerTarget", () => {
  test("a profile, ALERTMANAGER_URL, or no-binding", () => {
    expect(resolveAlertmanagerTarget({ environment: "prod", config, env: {} })).toMatchObject({ kind: "mimir", tenant: "shop", alertmanagerPrefix: "/alertmanager" });
    expect(resolveAlertmanagerTarget({ environment: "dev", config, env: { ALERTMANAGER_URL: "http://am:9093/" } })).toMatchObject({ kind: "alertmanager", url: "http://am:9093" });
    expect(resolveAlertmanagerTarget({ environment: "bare", config, env: {} })).toMatchObject({ reason: "no-binding" });
  });
});

describe("the namespace boundary", () => {
  const target = { namespace: "shop", groupNamespaces: { infra: "platform", api: "shop" } };
  test("declaredNamespaces is namespace and every groupNamespaces value, once each", () => {
    expect(declaredNamespaces(target)).toEqual(["shop", "platform"]);
    expect(declaredNamespaces({ groupNamespaces: {} })).toEqual([]);
  });
  test("namespaceOfGroup prefers the group's own entry", () => {
    expect(namespaceOfGroup(target, "infra")).toBe("platform");
    expect(namespaceOfGroup(target, "checkout")).toBe("shop");
  });
});
