/**
 * Type-level guarantees of the hand-written declarations. Each
 * `@ts-expect-error` line must fail to compile: `tsconfig.typecheck.json`
 * (scripts/typecheck.ts in CI) fails on an unused one, so a type that starts
 * accepting what it used to reject breaks the build. The invalid declarations
 * sit in functions that are never called, so nothing here throws at runtime.
 */
import { describe, expectTypeOf, test } from "vitest";
import {
  Receiver,
  Route,
  RuleGroup,
  Slo,
  TimeInterval,
  sloMetrics,
  type ReceiverEntity,
  type Rule,
  type RuleGroupEntity,
  type RuleGroupProps,
  type SloMetrics,
  type SloProps,
} from "./index";

describe("rule groups", () => {
  test("a group needs a name and rules, and every rule an expr", () => {
    expectTypeOf(RuleGroup).constructorParameters.toEqualTypeOf<[RuleGroupProps]>();
    expectTypeOf<RuleGroupProps["rules"]>().toEqualTypeOf<Rule[]>();
    expectTypeOf(new RuleGroup({ name: "api", rules: [] })).toEqualTypeOf<RuleGroupEntity>();

    const rejected = () => [
      // @ts-expect-error a group without a name
      new RuleGroup({ rules: [] }),
      // @ts-expect-error a group without rules
      new RuleGroup({ name: "api" }),
      // @ts-expect-error a recording rule without its expression
      new RuleGroup({ name: "api", rules: [{ record: "job:up:sum" }] }),
      // @ts-expect-error an alerting rule without its expression
      new RuleGroup({ name: "api", rules: [{ alert: "Down", for: "5m" }] }),
      // @ts-expect-error label values are strings, as Prometheus stores them
      new RuleGroup({ name: "api", rules: [{ alert: "Down", expr: "up == 0", labels: { priority: 1 } }] }),
      // @ts-expect-error `for` is a duration string, not a number of seconds
      new RuleGroup({ name: "api", rules: [{ alert: "Down", expr: "up == 0", for: 300 }] }),
    ];
    void rejected;
  });
});

describe("alertmanager", () => {
  test("a route names a receiver, and its time intervals by TimeInterval, never the other way round", () => {
    const oncall = new Receiver({ name: "oncall" });
    const weekend = new TimeInterval({ name: "weekend", time_intervals: [{ weekdays: ["saturday", "sunday"] }] });
    expectTypeOf(oncall).toEqualTypeOf<ReceiverEntity>();

    // By entity or by name, for a receiver declared outside the build.
    new Route({ receiver: oncall, mute_time_intervals: [weekend] });
    new Route({ receiver: "oncall", mute_time_intervals: ["weekend"] });

    const rejected = () => [
      // @ts-expect-error a time interval is not a receiver
      new Route({ receiver: weekend }),
      // @ts-expect-error a receiver is not a time interval
      new Route({ receiver: oncall, mute_time_intervals: [oncall] }),
      // @ts-expect-error a receiver needs a name
      new Receiver({ webhook_configs: [{ url: "http://hook:8080/" }] }),
    ];
    void rejected;
  });
});

describe("Slo", () => {
  test("an SLO needs a name, objective, window and an SLI over total events", () => {
    const sli = { errors: "sum(rate(errors_total[{{window}}]))", total: "sum(rate(requests_total[{{window}}]))" };
    const slo = Slo({ name: "checkout", objective: 0.999, window: "30d", sli });
    expectTypeOf(slo.rules).toEqualTypeOf<RuleGroupEntity>();
    expectTypeOf(sloMetrics(slo)).toEqualTypeOf<SloMetrics>();
    expectTypeOf(Slo).parameter(0).toEqualTypeOf<SloProps>();

    const rejected = () => [
      // @ts-expect-error the objective is a fraction, not a string
      Slo({ name: "checkout", objective: "99.9%", window: "30d", sli }),
      // @ts-expect-error an SLO without a window
      Slo({ name: "checkout", objective: 0.999, sli }),
      // @ts-expect-error an SLI without total events has no ratio
      Slo({ name: "checkout", objective: 0.999, window: "30d", sli: { errors: sli.errors } }),
    ];
    void rejected;
  });
});
