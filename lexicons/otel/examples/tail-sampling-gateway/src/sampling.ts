/**
 * Tail sampling on the gateway. A trace is kept when it has an error, takes
 * at least 500ms, or falls in the 10% baseline.
 *
 * With more than one gateway replica, the agents must send every span of a
 * trace to the same one: give them a `loadbalancing` exporter routed by
 * `traceID` (the k8s lexicon's `gatewayExporter()` does).
 */
import { ForwardConnector, TailSamplingProcessor, type TailSamplingPolicy } from "@intentius/chant-lexicon-otel";

/** Hands every span to `traces/sampled`, so sampling runs after the metrics branch. */
const toSampling = new ForwardConnector({ name: "sampling" });

const errors: TailSamplingPolicy = { name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } };
const slow: TailSamplingPolicy = { name: "slow", type: "latency", latency: { threshold_ms: 500 } };
const baseline: TailSamplingPolicy = { name: "baseline", type: "probabilistic", probabilistic: { sampling_percentage: 10 } };
const sampling = new TailSamplingProcessor({ decision_wait: "10s", num_traces: 50000, policies: [errors, slow, baseline] });

export { toSampling, sampling };
