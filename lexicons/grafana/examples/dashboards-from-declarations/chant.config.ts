import type { ChantConfig } from "@intentius/chant";

// The collector, the SLO and the dashboards that read them share one build
// root, so each lexicon's checks see what they join across (chant #1939).
export default { lexicons: ["otel", "prometheus", "grafana"] } satisfies ChantConfig;
