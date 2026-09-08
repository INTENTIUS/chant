import { ACTIVITY_PROFILES, Op, phase, shell } from "@intentius/chant/op";

/**
 * The smallest Op there is.
 *
 * `chant run hello` executes this in-process — phased, with per-step retries
 * and `onFailure` compensation. Nothing else is running: no server, no worker,
 * no cloud.
 *
 * A step's `profile` names a timeout-and-retry shape from `ACTIVITY_PROFILES`
 * in `@intentius/chant/op`. Six names cover what infra steps actually do —
 * fast idempotent work, long infra, a K8s wait loop, a human gate, an Argo
 * sync, a deterministic policy check — so the tuning lives in one table
 * instead of inline at every call site, and the overview below reads the
 * timeout back off it rather than restating a number that could drift.
 *
 * The table is read by its literal key: an Op is static data, so a computed
 * key from a variable is not evaluable (EVL003).
 */
export default Op({
  name: "hello",
  overview: `Minimal local Op — one shell step, ${ACTIVITY_PROFILES.fastIdempotent.timeout} timeout`,
  phases: [
    phase("Greet", [
      shell("echo hello from chant", { profile: "fastIdempotent" }),
    ]),
  ],
});
