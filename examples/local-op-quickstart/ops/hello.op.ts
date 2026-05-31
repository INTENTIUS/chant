import { Op, phase, shell } from "@intentius/chant-lexicon-temporal";

/**
 * Minimal Op that runs locally with no Temporal server.
 *
 * `chant run hello` executes this in-process — phased, with retries — using the
 * local executor (the default). No Temporal worker, server, or cloud required.
 * For durable resume, gates, and schedules, configure a Temporal profile and
 * pass `--temporal`.
 */
export default Op({
  name: "hello",
  overview: "Minimal local Op — no Temporal server required",
  taskQueue: "hello",
  phases: [
    phase("Greet", [
      shell("echo hello from chant"),
    ]),
  ],
});
