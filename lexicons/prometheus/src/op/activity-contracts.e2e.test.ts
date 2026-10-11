import { describe, expect, test } from "vitest";
import {
  ConvergeOp,
  Op,
  eq,
  isActivityContract,
  loadActivities,
  loadActivityContracts,
  phase,
  report,
  validateActivitySteps,
  validateStepOutputRefs,
  when,
  type ActivityContract,
  type ResourceSymptom,
} from "@intentius/chant/op";
import { load } from "js-yaml";
import * as contracts from "./activity-contracts";
import * as activities from "./activities";
import {
  alertmanagerSilence,
  alertmanagerUnsilence,
  amtoolCheckConfig,
  amtoolRoutesTest,
  promtoolCheckRules,
  promtoolTestRules,
  ruleAudit,
  rulesLoadedObserve,
} from "./builders";
import { RuleAuditOp } from "./audit-op";
import { Slo } from "../composites/slo";

const CONTRACTS: Map<string, ActivityContract> = new Map(
  Object.values(contracts).filter(isActivityContract).map((c) => [c.name, c]),
);

const op = (steps: unknown[]) => ({ name: "check", phases: [{ name: "Check", steps: steps as never[] }] });

describe("prometheus activity contracts (#3369)", () => {
  test("every exported activity has a contract with a return schema, and nothing else is exported", () => {
    for (const [key, value] of Object.entries(contracts)) {
      expect(isActivityContract(value), `${key} is not an ActivityContract`).toBe(true);
      expect((value as ActivityContract).returns).toBeDefined();
    }
    const fns = Object.entries(activities).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
    expect([...CONTRACTS.keys()].sort()).toEqual(fns);
    expect(fns).toEqual([
      "alertmanagerSilence",
      "alertmanagerUnsilence",
      "amtoolCheckConfig",
      "amtoolRoutesTest",
      "promtoolCheckRules",
      "promtoolTestRules",
      "ruleAudit",
      "rulesLoadedObserve",
    ]);
  });

  test("the builders' steps validate, and a misspelled key is an error", () => {
    const steps = [
      promtoolCheckRules({ rules: "dist/prometheus/rules.yml" }),
      promtoolTestRules({ rules: "dist/prometheus/rules.yml", tests: ["tests/slo.test.yml"] }),
      amtoolCheckConfig({ config: "dist/prometheus/alertmanager.yml" }),
      amtoolRoutesTest({ config: "dist/prometheus/alertmanager.yml", labels: { severity: "page" }, expect: "oncall" }),
      alertmanagerSilence({ matchers: ['alertname="SloBurn"'], duration: "30m", record: "deploy" }),
      alertmanagerUnsilence({ record: "deploy" }),
      ruleAudit({ mode: "issue", selectorBudget: 10 }),
    ];
    expect(validateActivitySteps(op(steps), CONTRACTS)).toEqual([]);
    const issues = validateActivitySteps(op([{ kind: "activity", fn: "alertmanagerSilence", args: { matchers: {}, duraton: "5m" } }]), CONTRACTS);
    expect(issues.some((i) => i.message.includes("duraton"))).toBe(true);
  });

  test("promtoolTestRules({ slos }) generates the tests at build time", () => {
    const slo = Slo({ name: "checkout", objective: 0.99, window: "30d", sli: { good: 'sum(rate(req_total{code="200"}[{{window}}]))', total: "sum(rate(req_total[{{window}}]))" } });
    const step = promtoolTestRules({ rules: "dist/prometheus/rules.yml", slos: [{ slo, good: 'req_total{code="200"}', bad: 'req_total{code="500"}' }] });
    const docs = step.args?.testYaml as string[];
    expect(docs.length).toBe(2);
    expect((load(docs[0]) as { rule_files: string[] }).rule_files).toEqual(["rules.yml"]);
    expect(step.args).not.toHaveProperty("slos");
    expect(validateActivitySteps(op([step]), CONTRACTS)).toEqual([]);
  });

  test("ConvergeOp({ observe: rulesLoadedObserve }) passes OPS012 and OPS013", () => {
    const { op: converge } = ConvergeOp({
      name: "rules-loaded",
      env: "local",
      schedule: "*/5 * * * *",
      observe: rulesLoadedObserve({ url: "http://localhost:9090", rules: "dist/prometheus/rules.yml" }),
      rules: [when<ResourceSymptom>(eq("status", "drifted"), report("rule group not loaded or failing"), { id: "group-drift", why: "say so" })],
    });
    expect(validateActivitySteps(converge.props as never, CONTRACTS)).toEqual([]);
    expect(validateStepOutputRefs(converge.props as never, CONTRACTS)).toEqual([]);
    expect(validateStepOutputRefs(converge.props as never, new Map()).length).toBeGreaterThan(0);
  });

  test("a silence around a change: the final phase reads the id; onFailure expires through the record", () => {
    const silence = alertmanagerSilence({ id: "silence", matchers: { slo: "checkout" }, duration: "30m", record: "deploy" });
    const change = Op({
      name: "deploy",
      overview: "deploy with alerts silenced",
      phases: [phase("Silence", [silence]), phase("Unsilence", [alertmanagerUnsilence({ silenceId: silence.out.silenceId, record: "deploy" })])],
      onFailure: [phase("Unsilence", [alertmanagerUnsilence({ record: "deploy" })])],
    });
    expect(validateActivitySteps(change.props as never, CONTRACTS)).toEqual([]);
    expect(validateStepOutputRefs(change.props as never, CONTRACTS)).toEqual([]);
    expect(silence.profile).toBe("atMostOnce");
  });

  test("RuleAuditOp is one ruleAudit step, its findings the run's outcome", () => {
    const { op: audit } = RuleAuditOp({ name: "rule-audit", url: "http://prom:9090", schedule: "0 * * * *", onFinding: "issue", pendingFor: "2h" });
    const props = audit.props as unknown as { schedule?: unknown; phases: Array<{ steps: Array<Record<string, unknown>> }> };
    expect(props.schedule).toEqual({ cron: "0 * * * *", overlap: "skip" });
    expect(props.phases[0].steps[0]).toMatchObject({
      fn: "ruleAudit",
      args: { mode: "issue", url: "http://prom:9090", pendingFor: "2h" },
      outcomeAttribute: { name: "Findings", from: "findings" },
    });
    expect(validateActivitySteps(props as never, CONTRACTS)).toEqual([]);
  });

  test("loadActivities and loadActivityContracts find them by the prometheus lexicon's name", async () => {
    const acts = await loadActivities(["prometheus"]);
    for (const fn of ["promtoolCheckRules", "rulesLoadedObserve", "alertmanagerSilence", "ruleAudit"]) expect(acts.has(fn), fn).toBe(true);
    const loaded = await loadActivityContracts(["prometheus"]);
    expect(loaded.get("rulesLoadedObserve")?.returns).toBeDefined();
  });
});

// ── Compile-time only ────────────────────────────────────────────────
function _typeChecksOnly(): void {
  // @ts-expect-error: duration is required.
  alertmanagerSilence({ matchers: { a: "1" } });
  // @ts-expect-error: labels are strings.
  amtoolRoutesTest({ config: "a.yml", labels: { replicas: 3 }, expect: "x" });
  // @ts-expect-error: mode is report or issue.
  ruleAudit({ mode: "pull-request" });
  // @ts-expect-error: the test seam is not an authoring option.
  rulesLoadedObserve({ groups: ["g"], _fetch: fetch });
}
void _typeChecksOnly;
