/**
 * The observe-converge example's Ops (#3369): each one passes the Op checks
 * `chant build` and `chant lint` run (OPS012 against the activities' args
 * contracts, OPS013 against their return schemas), and the collector it
 * observes builds to a config that declares the endpoints the observer
 * reads. The rule file is built and linted by `examples.test.ts`'s harness
 * with the other examples. The run against a live Prometheus and collector
 * is `observe-converge.e2e.test.ts`.
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import { loadActivityContracts, validateActivitySteps, validateStepOutputRefs } from "@intentius/chant/op";
import { otelSerializer } from "@intentius/chant-lexicon-otel";
import { declaredEndpoints } from "@intentius/chant-lexicon-otel/op/activities/collector-health";
import { rulesLoaded } from "./observe-converge/ops/rules-loaded.op";
import { collectorHealth } from "./observe-converge/ops/collector-health.op";
import { checks } from "./observe-converge/ops/checks.op";
import { ruleAudit } from "./observe-converge/ops/rule-audit.op";

const dir = join(import.meta.dirname, "observe-converge");

describe("observe-converge example", () => {
  test("every Op passes OPS012 and OPS013 with the otel and prometheus contracts", async () => {
    const contracts = await loadActivityContracts(["prometheus", "otel"]);
    for (const op of [rulesLoaded, collectorHealth, checks, ruleAudit]) {
      const props = op.props as never;
      expect(validateActivitySteps(props, contracts), (op.props as unknown as { name: string }).name).toEqual([]);
      expect(validateStepOutputRefs(props, contracts), (op.props as unknown as { name: string }).name).toEqual([]);
    }
  });

  test("the ConvergeOps observe through the lexicons' observer steps", () => {
    const observer = (op: typeof rulesLoaded) => (op.props as unknown as { phases: Array<{ name: string; steps: Array<{ fn: string }> }> }).phases[0].steps[0].fn;
    expect(observer(rulesLoaded)).toBe("rulesLoadedObserve");
    expect(observer(collectorHealth)).toBe("collectorHealthObserve");
  });

  test("the SLO's promtool tests are generated into the check Op", () => {
    const steps = (checks.props as unknown as { phases: Array<{ steps: Array<{ fn: string; args?: { testYaml?: string[] } }> }> }).phases[0].steps;
    const testStep = steps.find((s) => s.fn === "promtoolTestRules")!;
    expect(testStep.args?.testYaml?.length).toBe(2);
  });

  test("the collector builds with a health_check and metrics endpoint the observer reads", async () => {
    const result = await build(join(dir, "collector"), [otelSerializer]);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("otel");
    const config = load(typeof out === "string" ? out : out!.primary) as Record<string, unknown>;
    expect(declaredEndpoints(config)).toEqual([
      { kind: "healthCheck", url: "http://localhost:13133/" },
      { kind: "telemetry", url: "http://localhost:8888/metrics" },
    ]);
  });
});
