// Every five minutes, on the observe dial: is each rule group the build
// declares loaded by Prometheus, and is every rule in it healthy?
//
// The observer reads dist/rules.yml for the declared groups on each tick and
// asks Prometheus's /api/v1/rules (at $PROMETHEUS_URL, else
// localhost:9090). A group Prometheus has not loaded, or one with a rule in
// `health: "err"`, is drifted, with the rule's lastError as the detail.
import { ConvergeOp, eq, report, when, type ResourceSymptom } from "@intentius/chant/op";
import { rulesLoadedObserve } from "@intentius/chant-lexicon-prometheus";

export const { op: rulesLoaded } = ConvergeOp({
  name: "rules-loaded",
  env: "local",
  dial: "observe",
  schedule: "*/5 * * * *",
  observe: rulesLoadedObserve({ rules: "dist/rules.yml" }),
  rules: [
    when<ResourceSymptom>(eq("status", "drifted"), report("a declared rule group is not loaded or has a failing rule"), {
      id: "rule-group-drift",
      why: "Prometheus evaluates only what it loaded; a group it dropped alerts on nothing, so say so before anyone relies on it.",
    }),
  ],
});
