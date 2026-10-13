import type { ChantConfig } from "@intentius/chant";

// The SLO's Prometheus rules and the Grafana alert rules that read them share
// one build root, so GRAF108 and GRAF112 check the rules' queries against the
// datasources declared here.
export default { lexicons: ["prometheus", "grafana"] } satisfies ChantConfig;
