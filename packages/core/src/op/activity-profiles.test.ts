import { describe, test, expect } from "vitest";
import { ACTIVITY_PROFILES, ACTIVITY_PROFILE_NAMES, type ActivityProfileName } from "./activity-profiles";
import { KNOWN_ACTIVITY_PROFILES } from "./activity-contract";
import { activity } from "./builders";

/**
 * chant #2114 — the profile table moved out of a hosting lexicon into core and
 * lost its prefix. What a profile carries is a timeout and a retry policy;
 * `heartbeatTimeout` configured a worker's liveness protocol and has no subject
 * in an in-process step, so it did not come along.
 */
describe("ACTIVITY_PROFILES", () => {
  test("carries the six named profiles", () => {
    expect(Object.keys(ACTIVITY_PROFILES).sort()).toEqual(
      ["argoSync", "fastIdempotent", "humanGate", "k8sWait", "longInfra", "policyCheck"],
    );
  });

  test("every profile has a timeout, and none has a worker-era field", () => {
    for (const [name, profile] of Object.entries(ACTIVITY_PROFILES)) {
      expect(typeof profile.timeout, `${name}.timeout`).toBe("string");
      expect(profile, `${name} should have no heartbeatTimeout`).not.toHaveProperty("heartbeatTimeout");
      expect(profile, `${name} should have no startToCloseTimeout`).not.toHaveProperty("startToCloseTimeout");
    }
  });

  test("the retry shapes that mattered survived the move", () => {
    expect(ACTIVITY_PROFILES.humanGate.retry.maximumAttempts).toBe(1);
    expect(ACTIVITY_PROFILES.policyCheck.retry.maximumAttempts).toBe(1);
    expect(ACTIVITY_PROFILES.k8sWait.retry.nonRetryableErrorTypes).toContain("ReadinessFailedError");
    expect(ACTIVITY_PROFILES.argoSync.retry.nonRetryableErrorTypes).toContain("ArgoSyncFailedError");
  });

  test("KNOWN_ACTIVITY_PROFILES is the table's own key list, not a second copy", () => {
    expect(KNOWN_ACTIVITY_PROFILES).toBe(ACTIVITY_PROFILE_NAMES);
    expect([...KNOWN_ACTIVITY_PROFILES].sort()).toEqual(Object.keys(ACTIVITY_PROFILES).sort());
  });
});

// ── Compile-time-only: ActivityStep.profile is derived from the table ────────
function _typeChecksOnly(): void {
  const names: ActivityProfileName[] = [
    "fastIdempotent", "longInfra", "k8sWait", "humanGate", "argoSync", "policyCheck",
  ];
  void names;

  activity("shellCmd", { cmd: "true" }, "policyCheck");

  // @ts-expect-error — a seventh profile name is not in ACTIVITY_PROFILES.
  activity("shellCmd", { cmd: "true" }, "leisurely");

  // @ts-expect-error — same rejection through the step's own field.
  const _step: { profile?: ActivityProfileName } = { profile: "leisurely" };
  void _step;
}
void _typeChecksOnly;
