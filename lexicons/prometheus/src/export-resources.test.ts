/**
 * Live export (#3371): `chant import --from <env>` against a fake Mimir
 * ruler, a fake plain Prometheus and fake Alertmanagers
 * (./api/fake-servers.ts), the ruler and the Alertmanager behind real HTTP
 * servers on localhost. The last test runs core's `liveImportFromPlugins`
 * over the plugin, bound by environment variables, and reads the files it
 * writes.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportResources, type PrometheusExportOptions } from "./export-resources";
import { fakeAlertmanager, fakeHttp, fakeRuler, serveFake, type FakeAlertmanagerState, type FakeRulerState } from "./api/fake-servers";
import { EVALUATED_IMPORT_WARNING } from "./api/evaluated";
import { PrometheusGenerator } from "./import/generator";
import { ALERTMANAGER_RESOURCE_TYPE, RULE_FILE_RESOURCE_TYPE, type AlertmanagerResourceProperties, type RuleFileResourceProperties } from "./import/parser";
import { Slo } from "./composites/slo";
import { ruleGroupConfig } from "./rules";
import { prometheusPlugin } from "./plugin";
import type { RawRuleGroup } from "./api/ruler";
import type { TemplateIR } from "@intentius/chant/import/parser";

const sloGroup = ruleGroupConfig(
  Slo({ name: "checkout", objective: 0.99, window: "30d", sli: { errors: "sum(rate(e[{{window}}]))", total: "sum(rate(t[{{window}}]))" } }).rules,
) as unknown as RawRuleGroup;

const apiGroup: RawRuleGroup = {
  name: "api",
  interval: "30s",
  // Mimir keeps fields a rule file does not have; the importer names them.
  source_tenants: ["shop", "payments"],
  rules: [{ alert: "ApiDown", expr: 'up{job="api"} == 0', for: "5m", labels: { severity: "page" } }],
};

function rulerState(): FakeRulerState {
  return {
    kind: "mimir",
    tenant: "shop",
    namespaces: {
      shop: [apiGroup, sloGroup],
      platform: [{ name: "infra", rules: [{ record: "node:up:sum", expr: 'sum(up{job="node"})' }] }],
      other: [{ name: "foreign", rules: [{ record: "a:b", expr: "sum(a)" }] }],
    },
  };
}

const original = readFileSync(join(import.meta.dirname, "api", "testdata", "am-status-original.yml"), "utf8");

let ruler = rulerState();
const rulerCalls: string[] = [];
let am: FakeAlertmanagerState = { kind: "alertmanager", original };
let rulerUrl = "";
let amUrl = "";
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const r = await serveFake((req) => fakeRuler(ruler, rulerCalls)(req));
  const a = await serveFake((req) => fakeAlertmanager(am)(req));
  rulerUrl = r.url;
  amUrl = a.url;
  closers.push(r.close, a.close);
});
afterAll(async () => {
  for (const c of closers) await c();
});

function profile(ruler: Record<string, unknown> | undefined = { kind: "mimir", url: rulerUrl, tenant: "shop", namespace: "shop", groupNamespaces: { infra: "platform" } }) {
  return { prometheus: { profiles: { prod: { ...(ruler ? { ruler } : {}), alertmanager: { url: amUrl } } } } } as PrometheusExportOptions["config"];
}

function exportProd(opts: Partial<PrometheusExportOptions> = {}) {
  return exportResources({ environment: "prod", config: profile(), env: {}, ...opts });
}

const ruleFile = (ir: TemplateIR) => (ir.resources.find((r) => r.type === RULE_FILE_RESOURCE_TYPE)?.properties as unknown as RuleFileResourceProperties | undefined)?.file;
const amConfig = (ir: TemplateIR) => (ir.resources.find((r) => r.type === ALERTMANAGER_RESOURCE_TYPE)?.properties as unknown as AlertmanagerResourceProperties | undefined)?.config;

describe("rule groups from a Mimir ruler", () => {
  it("reads the declared namespaces only, and the groups parse as a rule file's would", async () => {
    ruler = rulerState();
    am = { kind: "alertmanager", original };
    rulerCalls.length = 0;
    const ir = await exportProd();
    expect(ruleFile(ir)?.groups.map((g) => g.name)).toEqual(["api", "slo-checkout", "infra"]);
    expect(ruleFile(ir)?.groups[0]).toEqual({ name: "api", interval: "30s", rules: [{ alert: "ApiDown", expr: 'up{job="api"} == 0', for: "5m", labels: { severity: "page" } }] });
    expect(rulerCalls).toEqual(["GET /prometheus/config/v1/rules/shop", "GET /prometheus/config/v1/rules/platform"]);
    expect(ir.warnings?.some((w) => w.startsWith('ruler namespace "shop": group "api": "source_tenants" is not a rule group field'))).toBe(true);
  });

  it("generates RuleGroups, and the group an Slo built as that Slo", async () => {
    ruler = rulerState();
    const files = Object.fromEntries(new PrometheusGenerator().generate(await exportProd({ selector: { type: "Prometheus::Rules::RuleGroup" } })).map((f) => [f.path, f.content]));
    expect(files["slos.ts"]).toContain("const checkout = Slo({");
    expect(files["rules.ts"]).toContain("new RuleGroup({");
    expect(files["rules.ts"]).toContain('name: "infra"');
  });

  it("a selector names one group and leaves the Alertmanager out", async () => {
    ruler = rulerState();
    const ir = await exportProd({ selector: { type: "Prometheus::Rules::RuleGroup", name: "infra" } });
    expect(ruleFile(ir)?.groups.map((g) => g.name)).toEqual(["infra"]);
    expect(amConfig(ir)).toBeUndefined();
  });

  it("a declared namespace the ruler does not have is a warning, not an error", async () => {
    ruler = { ...rulerState(), namespaces: { shop: [apiGroup] } };
    const ir = await exportProd();
    expect(ruleFile(ir)?.groups.map((g) => g.name)).toEqual(["api"]);
    expect(ir.warnings).toContain(`ruler namespace "platform" has no rule groups on ${rulerUrl}`);
  });

  it("a group read from a namespace the profile does not give it is imported with a warning", async () => {
    ruler = { ...rulerState(), namespaces: { shop: [apiGroup], platform: [{ name: "infra", rules: [] }, { name: "stray", rules: [] }] } };
    const ir = await exportProd();
    expect(ir.warnings?.some((w) => w.startsWith('rule group "stray" was read from ruler namespace "platform"'))).toBe(true);
    expect(ir.warnings?.some((w) => w.includes('"infra" was read from'))).toBe(false);
  });

  it("the same group name in two namespaces imports the first, with a warning", async () => {
    ruler = { ...rulerState(), namespaces: { shop: [apiGroup], platform: [{ ...apiGroup, interval: "1m" }] } };
    const ir = await exportProd();
    expect(ruleFile(ir)?.groups).toHaveLength(1);
    expect(ruleFile(ir)?.groups[0].interval).toBe("30s");
    expect(ir.warnings?.some((w) => w.startsWith('rule group "api" is in both namespace "shop" and namespace "platform"'))).toBe(true);
  });

  it("with no namespace declared, an ad-hoc import reads every namespace and says so; with owned it reads none", async () => {
    ruler = rulerState();
    const adHoc = { PROMETHEUS_RULER_URL: rulerUrl, PROMETHEUS_RULER_TENANT: "shop" };
    let ir = await exportResources({ environment: "dev", config: {}, env: adHoc, selector: { type: "Prometheus::Rules::RuleGroup" } });
    expect(ruleFile(ir)?.groups.map((g) => g.name).sort()).toEqual(["api", "foreign", "infra", "slo-checkout"]);
    expect(ir.warnings?.some((w) => w.includes("declares no ruler namespace, so every namespace of the tenant was read (shop, platform, other)"))).toBe(true);
    rulerCalls.length = 0;
    ir = await exportResources({ environment: "dev", config: {}, env: adHoc, owned: true, selector: { type: "Prometheus::Rules::RuleGroup" } });
    expect(ir.resources).toEqual([]);
    expect(rulerCalls).toEqual([]);
    expect(ir.warnings?.some((w) => w.startsWith("no rule groups are imported with --owned"))).toBe(true);
  });

  it("a refused tenant fails the export rather than importing nothing", async () => {
    ruler = rulerState();
    await expect(exportProd({ config: profile({ kind: "mimir", url: rulerUrl, tenant: "nope", namespace: "shop" }) })).rejects.toThrow(/returned 401/);
  });
});

describe("rule groups from a plain Prometheus", () => {
  const state: FakeRulerState = {
    kind: "prometheus",
    namespaces: {},
    evaluated: [
      {
        name: "api",
        file: "/etc/prometheus/api.yml",
        interval: 30,
        rules: [{ type: "alerting", name: "ApiDown", query: 'up{job="api"} == 0', duration: 300, labels: { severity: "page" }, annotations: {}, health: "ok" }],
      },
      { name: "node", file: "/etc/prometheus/node.yml", interval: 60, rules: [{ type: "recording", name: "node:up:sum", query: 'sum(up{job="node"})', health: "ok" }] },
    ],
  };
  const options = (ruler: Record<string, unknown>, extra: Partial<PrometheusExportOptions> = {}) =>
    exportResources({
      environment: "prod",
      config: { prometheus: { profiles: { prod: { ruler: { kind: "prometheus", url: "http://prometheus.test", ...ruler } } } } } as PrometheusExportOptions["config"],
      env: {},
      http: { ruler: fakeHttp(fakeRuler(state)) },
      ...extra,
    });

  it("maps /api/v1/rules back to rule-file groups and says what that loses", async () => {
    const ir = await options({});
    expect(ruleFile(ir)?.groups).toEqual([
      { name: "api", interval: "30s", rules: [{ alert: "ApiDown", expr: 'up{job="api"} == 0', for: "5m", labels: { severity: "page" } }] },
      { name: "node", interval: "1m", rules: [{ record: "node:up:sum", expr: 'sum(up{job="node"})' }] },
    ]);
    expect(ir.warnings).toContain(EVALUATED_IMPORT_WARNING);
    expect(ir.warnings?.some((w) => w.startsWith("not imported, Alertmanager:"))).toBe(true);
  });

  it("a named rule file bounds what is read, and owned with none names nothing", async () => {
    expect(ruleFile(await options({ namespace: "/etc/prometheus/node.yml" }))?.groups.map((g) => g.name)).toEqual(["node"]);
    const owned = await options({}, { owned: true });
    expect(owned.resources).toEqual([]);
  });
});

describe("the Alertmanager config", () => {
  it("from /api/v2/status: Alertmanager's defaults are taken out and masked secrets are named", async () => {
    am = { kind: "alertmanager", original };
    const ir = await exportProd({ selector: { type: "Prometheus::Alertmanager::Config" } });
    const config = amConfig(ir);
    expect(config?.global).toEqual({ smtp_from: "am@example.com", smtp_smarthost: "smtp.example.com:587" });
    expect(config?.receivers?.map((r) => r.name)).toEqual(["team", "pager"]);
    expect(config?.route).toMatchObject({ receiver: "team", routes: [{ receiver: "pager", matchers: ['severity="page"'] }] });
    expect(ruleFile(ir)).toBeUndefined();
    const secrets = ir.warnings?.find((w) => w.includes('read "<secret>"'));
    expect(secrets).toContain("receivers[0].webhook_configs[0].url");
    expect(secrets).toContain("receivers[1].pagerduty_configs[0].routing_key");
  });

  it("verbatim keeps what Alertmanager wrote", async () => {
    am = { kind: "alertmanager", original };
    const config = amConfig(await exportProd({ verbatim: true, selector: { type: "Prometheus::Alertmanager::Route" } }));
    expect(config?.global).toMatchObject({ resolve_timeout: "5m", smtp_hello: "localhost" });
  });

  it("from Mimir's /api/v1/alerts: the config as uploaded, with the templates named in a warning", async () => {
    const uploaded = "route:\n  receiver: team\n  group_wait: 30s\nreceivers:\n  - name: team\n    webhook_configs:\n      - url: http://hooks.example.com/team\n        send_resolved: true\n";
    const state: FakeAlertmanagerState = { kind: "mimir", tenant: "shop", uploaded: { alertmanager_config: uploaded, template_files: { "team.tmpl": '{{ define "x" }}y{{ end }}' } } };
    const ir = await exportResources({
      environment: "prod",
      config: { prometheus: { profiles: { prod: { alertmanager: { kind: "mimir", url: "http://mimir.test", tenant: "shop" } } } } },
      env: {},
      http: { alertmanager: fakeHttp(fakeAlertmanager(state), { "x-scope-orgid": "shop" }) },
    });
    // Uploaded as written: send_resolved: true stays, and group_wait is not taken for a default.
    expect(amConfig(ir)).toEqual({
      route: { receiver: "team", group_wait: "30s" },
      receivers: [{ name: "team", webhook_configs: [{ url: "http://hooks.example.com/team", send_resolved: true }] }],
    });
    expect(ir.warnings?.some((w) => w.includes("notification templates (team.tmpl) are not imported"))).toBe(true);
    expect(ir.warnings?.some((w) => w.startsWith("not imported, rule groups:"))).toBe(true);
  });
});

it("neither endpoint bound is an error that says why for both", async () => {
  await expect(exportResources({ environment: "prod", config: {}, env: {} })).rejects.toThrow(/rule groups: .*; Alertmanager: /);
});

it("chant import --from writes the ruler's groups and the Alertmanager's config as source", async () => {
  ruler = rulerState();
  am = { kind: "alertmanager", original };
  const { liveImportFromPlugins } = await import("@intentius/chant/cli/commands/import");
  const dir = mkdtempSync(join(tmpdir(), "prom-import-live-"));
  vi.stubEnv("PROMETHEUS_RULER_URL", rulerUrl);
  vi.stubEnv("PROMETHEUS_RULER_TENANT", "shop");
  vi.stubEnv("PROMETHEUS_RULER_NAMESPACE", "shop");
  vi.stubEnv("ALERTMANAGER_URL", amUrl);
  try {
    const result = await liveImportFromPlugins([prometheusPlugin], { environment: "nowhere", lexicon: "prometheus", output: join(dir, "src"), force: true });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    const written = readdirSync(join(dir, "src")).sort();
    expect(written).toEqual(expect.arrayContaining(["rules.ts", "slos.ts", "receivers.ts", "routes.ts"]));
    expect(readFileSync(join(dir, "src", "slos.ts"), "utf8")).toContain("Slo({");
    expect(readFileSync(join(dir, "src", "rules.ts"), "utf8")).not.toContain("foreign");
    expect(result.warnings.some((w) => w.includes('read "<secret>"'))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
