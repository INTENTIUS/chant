import { Receiver, Route, RuleGroup, type Rule, type RouteProps } from "@intentius/chant-lexicon-prometheus";

const rules: Rule[] = [
  { record: "job:up:sum", expr: "sum by (job) (up)" },
  { alert: "TargetDown", expr: "up == 0", for: "5m", labels: { severity: "page" }, annotations: { summary: "a target is down" } },
];

export const smoke = new RuleGroup({ name: "smoke", rules });

const oncall = new Receiver({ name: "oncall" });
const children: RouteProps[] = [{ matchers: ['severity="page"'], receiver: oncall }];

export const root = new Route({ receiver: "default", routes: children });
export const fallback = new Receiver({ name: "default" });
