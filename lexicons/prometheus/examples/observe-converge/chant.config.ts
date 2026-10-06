import type { ChantConfig } from "@intentius/chant";

// Both lexicons are listed so `chant run` loads their Op activities:
// rulesLoadedObserve and the promtool steps from prometheus,
// collectorHealthObserve and the otelcol steps from otel.
export default { lexicons: ["prometheus", "otel"] } satisfies ChantConfig;
