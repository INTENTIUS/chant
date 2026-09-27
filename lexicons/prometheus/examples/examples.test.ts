import { describe, expect, test } from "vitest";
import { join } from "path";
import { load, loadAll } from "js-yaml";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import {
  ALERTMANAGER_FILE,
  amtoolCheckConfig,
  hasTool,
  prometheusSerializer,
  promtoolCheckRules,
  validateAlertmanagerConfig,
  validateRuleFile,
  validateSeverityRouting,
  type AlertmanagerConfig,
  type RuleFileConfig,
} from "@intentius/chant-lexicon-prometheus";

/** Every example's rule file must pass the lexicon's own checks with nothing to report. */
function clean(output: string): RuleFileConfig {
  const file = load(output) as RuleFileConfig;
  expect(validateRuleFile(file)).toEqual([]);
  return file;
}

describeAllExamples(
  {
    lexicon: "prometheus",
    serializer: prometheusSerializer,
    outputKey: "prometheus",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": {
      checks: (output) => {
        const file = clean(output);
        expect(file.groups.map((g) => g.name)).toEqual(["api"]);
        expect(file.groups[0].rules.map((r) => ("record" in r ? r.record : r.alert))).toEqual([
          "job:http_requests:rate5m",
          "job:http_errors:ratio5m",
          "ApiErrorRatioHigh",
        ]);
      },
    },
    alerting: {
      checks: (output) => {
        const file = clean(output);
        expect(file.groups[0].labels).toEqual({ team: "payments" });
      },
    },
    // Built with the k8s serializer too, below.
    "k3d-stack": { skipBuild: true },
    "rules-from-data": {
      checks: (output) => {
        const file = clean(output);
        expect(file.groups.map((g) => g.name)).toEqual(["inventory", "orders"]);
        expect(file.groups[1].rules).toHaveLength(4);
      },
    },
  },
);

describe("the alerting example's two files", () => {
  const srcDir = join(import.meta.dirname, "alerting", "src");

  async function built(): Promise<{ rules: string; am: string }> {
    const result = await build(srcDir, [prometheusSerializer]);
    expect(result.errors).toHaveLength(0);
    const out = result.outputs.get("prometheus") as SerializerResult;
    return { rules: out.primary, am: out.files![ALERTMANAGER_FILE] };
  }

  test("alertmanager.yml is written beside the rule file, routes every severity and passes every check", async () => {
    const { rules, am } = await built();
    const file = load(rules) as RuleFileConfig;
    const config = load(am) as AlertmanagerConfig;
    expect(validateAlertmanagerConfig(config)).toEqual([]);
    expect(validateSeverityRouting([file], config)).toEqual([]);
    expect(config.route?.routes?.map((r) => r.receiver)).toEqual(["payments-oncall", "payments-tickets"]);
  });

  test.skipIf(!hasTool(process.env.PROMTOOL ?? "promtool"))("promtool accepts the rule file", async () => {
    const r = promtoolCheckRules((await built()).rules);
    expect(r.ok, r.output).toBe(true);
  });

  test.skipIf(!hasTool(process.env.AMTOOL ?? "amtool"))("amtool accepts alertmanager.yml", async () => {
    const r = amtoolCheckConfig((await built()).am);
    expect(r.ok, r.output).toBe(true);
  });
});

describe("the k3d-stack example", () => {
  test("its ConfigMaps carry exactly the files the prometheus serializer writes", async () => {
    const result = await build(join(import.meta.dirname, "k3d-stack", "src"), [k8sSerializer, prometheusSerializer]);
    expect(result.errors).toHaveLength(0);
    const k8s = result.outputs.get("k8s");
    const docs = loadAll(typeof k8s === "string" ? k8s : k8s!.primary) as Array<{ kind: string; metadata: { name: string }; data?: Record<string, string> }>;
    const cm = (name: string) => docs.find((d) => d.kind === "ConfigMap" && d.metadata.name === name)!.data!;
    const prom = result.outputs.get("prometheus") as SerializerResult;
    expect(cm("prometheus-config")["rules.yml"]).toBe(prom.primary);
    expect(cm("alertmanager-config")["alertmanager.yml"]).toBe(prom.files![ALERTMANAGER_FILE]);
    expect(validateRuleFile(load(prom.primary) as RuleFileConfig)).toEqual([]);
    const am = load(prom.files![ALERTMANAGER_FILE]) as AlertmanagerConfig;
    expect(validateAlertmanagerConfig(am)).toEqual([]);
    expect(validateSeverityRouting([load(prom.primary) as RuleFileConfig], am)).toEqual([]);
  });
});
