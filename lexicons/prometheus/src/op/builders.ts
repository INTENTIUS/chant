/**
 * Typed step builders for this lexicon's Op activities (#3369), following
 * the helm and fly builders: each one's options ARE the activity's own
 * `*Args` interface (minus its `_`-prefixed test seams), every field also
 * takes a `StepOutputRef`, and `profile` and `id` go to the step.
 *
 * `promtoolCheckRules`, `promtoolTestRules` and `amtoolCheckConfig` share
 * their names with the plain functions in `../tools.ts`, which the package
 * root already exports, so those three builders are reached here, at
 * `@intentius/chant-lexicon-prometheus/op/builders`. The root exports the
 * rest.
 */

import { activity, takeProfileAndId, type ActivityStep, type NamedActivityStep, type WithStepRefs } from "@intentius/chant/op";
import type {
  AmtoolCheckConfigArgs,
  AmtoolRoutesTestArgs,
  PromtoolCheckRulesArgs,
  PromtoolTestRulesArgs,
} from "./activities/promtool";
import type { AlertmanagerSilenceArgs, AlertmanagerUnsilenceArgs } from "./activities/silence";
import type { RulesLoadedObserveArgs } from "./activities/rules-loaded";
import type { RuleAuditArgs } from "./activities/rule-audit";
import { sloRuleTests, type SloTestInput } from "./slo-rule-tests";

type StepOpts = { profile?: ActivityStep["profile"]; id?: string };
type Authored<T> = Omit<T, `_${string}`>;

function step<Args>(fn: string, defaultProfile: NonNullable<ActivityStep["profile"]>) {
  return (args: WithStepRefs<Authored<Args>> & StepOpts): NamedActivityStep => {
    const { args: rest, profile, id } = takeProfileAndId(args as Record<string, unknown>);
    return activity(fn, rest, { profile: profile ?? defaultProfile, ...(id ? { id } : {}) });
  };
}

/** `promtool check rules` over built rule files. Defaults to the `fastIdempotent` profile. */
export const promtoolCheckRules = step<PromtoolCheckRulesArgs>("promtoolCheckRules", "fastIdempotent");

/**
 * `promtool test rules` over a built rule file. `slos` generates the tests
 * from `Slo` declarations at build time (`sloRuleTests`): each burn-rate
 * pair fires at its rate and not below it. Defaults to the `fastIdempotent`
 * profile.
 */
export const promtoolTestRules = (
  args: WithStepRefs<Authored<PromtoolTestRulesArgs>> & StepOpts & { slos?: SloTestInput[] },
): NamedActivityStep => {
  const { slos, ...rest } = args;
  if (!slos || slos.length === 0) return step<PromtoolTestRulesArgs>("promtoolTestRules", "fastIdempotent")(rest);
  const generated = sloRuleTests(slos);
  const given = rest.testYaml === undefined ? [] : Array.isArray(rest.testYaml) ? rest.testYaml : [rest.testYaml];
  return step<PromtoolTestRulesArgs>("promtoolTestRules", "fastIdempotent")({ ...rest, testYaml: [...(given as string[]), ...generated] });
};

/** `amtool check-config` over a built Alertmanager config. Defaults to the `fastIdempotent` profile. */
export const amtoolCheckConfig = step<AmtoolCheckConfigArgs>("amtoolCheckConfig", "fastIdempotent");

/** `amtool config routes test`: `labels` route to `expect`. Defaults to the `fastIdempotent` profile. */
export const amtoolRoutesTest = step<AmtoolRoutesTestArgs>("amtoolRoutesTest", "fastIdempotent");

/**
 * Silence alerts through Alertmanager's API for `duration`, recording the
 * silence id under `record` so `alertmanagerUnsilence` can expire it from
 * a final phase or an `onFailure` phase. Defaults to the `atMostOnce`
 * profile: a retry after a lost answer would create a second silence.
 */
export const alertmanagerSilence = step<AlertmanagerSilenceArgs>("alertmanagerSilence", "atMostOnce");

/** Expire the silences `record` holds (or `silenceId`). Defaults to the `fastIdempotent` profile. */
export const alertmanagerUnsilence = (args: WithStepRefs<Authored<AlertmanagerUnsilenceArgs>> & StepOpts = {}): NamedActivityStep =>
  step<AlertmanagerUnsilenceArgs>("alertmanagerUnsilence", "fastIdempotent")(args);

/**
 * Observe declared rule groups for a `ConvergeOp({ observe })`: one resource
 * per group, drifted when Prometheus has not loaded it or a rule in it has
 * `health: "err"`. Defaults to the `fastIdempotent` profile.
 */
export const rulesLoadedObserve = step<RulesLoadedObserveArgs>("rulesLoadedObserve", "fastIdempotent");

/** Audit a live Prometheus's rules, alerts and selectors (the step of `RuleAuditOp`). Defaults to the `fastIdempotent` profile. */
export const ruleAudit = (args: WithStepRefs<Authored<RuleAuditArgs>> & StepOpts = {}): NamedActivityStep =>
  step<RuleAuditArgs>("ruleAudit", "fastIdempotent")(args);
