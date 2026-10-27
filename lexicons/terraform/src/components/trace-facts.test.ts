/**
 * `terraform-apply`'s engine facts (INTENTIUS/chant#4555): the root and the
 * binary, for the step's span and run record.
 */

import { describe, expect, test } from "vitest";
import { terraformTraceFacts } from "./trace-facts";

describe("terraform-apply's trace facts (#4555)", () => {
  test("name the root, the configured binary and whether the wave's plan applied", () => {
    expect(terraformTraceFacts({ root: "network" }, { output: { root: "network", planDigest: "sha256:x", fromWavePlan: true, outputs: { vpc_id: "v" } } }, "/usr/local/bin/tofu")).toEqual({
      attributes: { root: "network", binary: "tofu", "apply.from_wave_plan": true, "apply.outputs": 1 },
    });
  });

  test("default to terraform, and keep the root and the cone on a failed apply", () => {
    expect(terraformTraceFacts({ root: "network", cone: "HEAD~1" }, { error: new Error("refused") }, undefined)).toEqual({
      attributes: { root: "network", binary: "terraform", "plan.cone": "HEAD~1" },
    });
  });
});
