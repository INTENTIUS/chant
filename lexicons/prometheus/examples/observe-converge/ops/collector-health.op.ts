// Every five minutes, on the observe dial: does the collector answer on the
// endpoints its config declares?
//
// The observer reads dist/collector.yaml on each tick: the health_check it
// enables (0.0.0.0:13133, read as localhost) and its own metrics (8888). A
// collector whose config enables no health_check would be unknown, never
// drifted.
import { ConvergeOp, eq, report, when, type ResourceSymptom } from "@intentius/chant/op";
import { collectorHealthObserve } from "@intentius/chant-lexicon-otel";

export const { op: collectorHealth } = ConvergeOp({
  name: "collector-health",
  env: "local",
  dial: "observe",
  schedule: "*/5 * * * *",
  observe: collectorHealthObserve({ collectors: [{ name: "collector", config: "dist/collector.yaml" }] }),
  rules: [
    when<ResourceSymptom>(eq("status", "drifted"), report("the collector is not answering on a declared endpoint"), {
      id: "collector-down",
      why: "Telemetry sent to a collector that is down is lost; report it before the dashboards go quiet.",
    }),
  ],
});
