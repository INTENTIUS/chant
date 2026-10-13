---
skill: chant-prometheus-kubernetes
description: Render the same RuleGroups into a Prometheus Operator PrometheusRule, or into ConfigMaps for a plain Prometheus and Alertmanager on Kubernetes
user-invocable: true
---

# Prometheus rules on Kubernetes

A `RuleGroup` from `@intentius/chant-lexicon-prometheus` renders to two places: the rule file, and a Prometheus Operator `PrometheusRule` from `@intentius/chant-lexicon-k8s`.

## Into a PrometheusRule

```ts
import { PrometheusRule } from "@intentius/chant-lexicon-k8s";
import { RuleGroup } from "@intentius/chant-lexicon-prometheus";

const api = new RuleGroup({
  name: "api",
  rules: [{ alert: "ApiDown", expr: 'up{job="api"} == 0', for: "5m", labels: { severity: "page" }, annotations: { summary: "api is down" } }],
});

export const apiRules = new PrometheusRule({
  metadata: { name: "api-rules", labels: { release: "kube-prometheus-stack" } },
  spec: { groups: [api] },
});
```

The k8s serializer writes each `RuleGroup` in `spec.groups` as the same group the rule file would hold. Declare the group with `const` (not exported) when it should only appear inside the CRD; export it too when the build should also write the rule file.

`MonitoredService` takes the groups directly:

```ts
MonitoredService({ name: "api", image: "api:1.0", ruleGroups: [api] });
```

Its older `alertRules` prop still works, and both may be set; the groups come after the `alertRules` group.

## Without the operator

For a plain Prometheus or Alertmanager Deployment, put the files in ConfigMaps with `ruleFileYaml(groups)` and `alertmanagerYaml(entities)`:

```ts
import { ConfigMap } from "@intentius/chant-lexicon-k8s";
import { ruleFileYaml, alertmanagerYaml } from "@intentius/chant-lexicon-prometheus";

export const rulesCm = new ConfigMap({ metadata: { name: "prometheus-rules" }, data: { "rules.yml": ruleFileYaml([api]) } });
export const amCm = new ConfigMap({ metadata: { name: "alertmanager" }, data: { "alertmanager.yml": alertmanagerYaml([root, oncall, sink]) } });
```
