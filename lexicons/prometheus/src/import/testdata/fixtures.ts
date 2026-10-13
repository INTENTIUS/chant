/**
 * Fixtures shared by the import round-trip tests (roundtrip.test.ts,
 * cli.test.ts) and the type-check of the generated source
 * (generated-types.e2e.test.ts).
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { build } from "@intentius/chant/build";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import { prometheusSerializer, ALERTMANAGER_FILE } from "../../serializer";
import { ruleFileYaml } from "../../build";
import { Slo } from "../../composites/slo";

export const pkgDir = resolve(import.meta.dirname, "../../..");
export const repoRoot = resolve(pkgDir, "../..");
export const read = (...p: string[]) => readFileSync(join(import.meta.dirname, ...p), "utf-8");

/** One file a build wrote: the rule file or `alertmanager.yml`. */
export interface BuiltFile {
  name: string;
  yaml: string;
}

/** The rule file and `alertmanager.yml` of one build output, whichever it has. */
export function builtFiles(out: string | SerializerResult | undefined): { rules?: string; alertmanager?: string } {
  if (out === undefined || out === "") return {};
  if (typeof out === "string") return out.startsWith("groups:") ? { rules: out } : { alertmanager: out };
  const primaryIsRules = out.primary.startsWith("groups:");
  return {
    ...(primaryIsRules ? { rules: out.primary } : { alertmanager: out.primary }),
    ...(out.files?.[ALERTMANAGER_FILE] !== undefined ? { alertmanager: out.files[ALERTMANAGER_FILE] } : {}),
  };
}

/** Every file each prometheus example builds, named `<example>/rules.yml` or `<example>/alertmanager.yml`. */
export async function exampleOutputs(): Promise<BuiltFile[]> {
  const examplesDir = join(pkgDir, "examples");
  const out: BuiltFile[] = [];
  for (const name of readdirSync(examplesDir).sort()) {
    const srcDir = join(examplesDir, name, "src");
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    // k3d-stack declares its Kubernetes workloads beside the rules.
    const serializers: Serializer[] = name === "k3d-stack" ? [k8sSerializer, prometheusSerializer] : [prometheusSerializer];
    const result = await build(srcDir, serializers);
    if (result.errors.length > 0) throw new Error(`${name}: ${result.errors.map(String).join("; ")}`);
    const files = builtFiles(result.outputs.get("prometheus"));
    if (files.rules !== undefined) out.push({ name: `${name}/rules.yml`, yaml: files.rules });
    if (files.alertmanager !== undefined) out.push({ name: `${name}/alertmanager.yml`, yaml: files.alertmanager });
  }
  return out;
}

const calls = "traces_span_metrics_calls_total";

/** Rule files `Slo()` builds, over the props that change its shape. */
export function sloOutputs(): BuiltFile[] {
  const good = {
    good: `sum(rate(${calls}{span_name="checkout",status_code!="STATUS_CODE_ERROR"}[{{window}}]))`,
    total: `sum(rate(${calls}{span_name="checkout"}[{{window}}]))`,
  };
  const errors = {
    errors: `sum(rate(http_requests_total{code=~"5.."}[{{window}}]))`,
    total: "sum(rate(http_requests_total[{{window}}]))",
  };
  const slos = [
    Slo({ name: "defaults", objective: 0.999, window: "30d", sli: errors }),
    Slo({
      name: "order-ack",
      objective: 0.995,
      window: "28d",
      description: "Orders are acknowledged without an error span.",
      sli: good,
      alerting: {
        page: { burnRates: "default", annotations: { runbook_url: "https://runbooks.example.com/order-ack" } },
        ticket: { burnRates: "default", for: "15m", labels: { team: "orders" } },
      },
      labels: { team: "orders" },
      interval: "1m",
    }),
    Slo({
      name: "custom",
      objective: 0.99,
      window: "7d",
      sli: errors,
      alerting: {
        alertName: "LatencyBudgetBurn",
        page: {
          severity: "critical",
          burnRates: [
            { long: "1h", short: "5m", factor: 10 },
            { long: "6h", short: "30m", budgetConsumed: 0.1 },
          ],
        },
        ticket: false,
      },
    }),
    Slo({ name: "no-alerts", objective: 0.95, window: "1w", sli: good, alerting: { page: false, ticket: false } }),
  ];
  return slos.map((s) => ({ name: `Slo ${s.rules.props.name}`, yaml: ruleFileYaml([s.rules]) }));
}

/** The vendored upstream samples, each with the source it came from in its header. */
export const UPSTREAM = [
  "prometheus-recording-rules.yml",
  "prometheus-alerting-rules.yml",
  "prometheus-alerting-templates.yml",
  "alertmanager-simple.yml",
  "alertmanager-route-labels.yml",
  "alertmanager-conf-good.yml",
  "alertmanager-mattermost-default-webhook-url-file.yml",
  "alertmanager-opsgenie-default-apikey-file.yml",
  "alertmanager-rocketchat-default-token-file.yml",
  "alertmanager-sns-topic-arn.yml",
  "alertmanager-telegram-default-bot-token-file.yml",
  "alertmanager-victorops-default-apikey-file.yml",
  "alertmanager-wechat-default-api-secret-file.yml",
];
