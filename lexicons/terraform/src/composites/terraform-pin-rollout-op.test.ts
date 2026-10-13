import { describe, expect, test } from "vitest";
import { validateActivitySteps, type ActivityStep, type OpConfig } from "@intentius/chant/op";
import { TerraformPinRolloutOp } from "./terraform-pin-rollout-op";
import { terraformPinRolloutContract } from "../op/activity-contracts";
import { parsePinRolloutArgs, pinRolloutExitCode, terraformCommands } from "../commands";

function props(config: Parameters<typeof TerraformPinRolloutOp>[0]): OpConfig {
  return (TerraformPinRolloutOp(config).op as unknown as { props: OpConfig }).props;
}

const BASE = { name: "vpc-1-4", module: "oci://registry.example.com/modules/vpc", from: "1.3.0", to: "1.4.0" };

describe("TerraformPinRolloutOp (#3189)", () => {
  test("one Rollout phase, one step, the rollout's status as the run outcome", () => {
    const op = props({ ...BASE, canaries: ["live/dev/vpc"], mode: "pull-request", schedule: "*/30 * * * *" });
    expect(op.phases.map((p) => p.name)).toEqual(["Rollout"]);
    const step = op.phases[0]!.steps[0] as ActivityStep;
    expect(step.fn).toBe("terraformPinRollout");
    expect(step.args).toEqual({ module: BASE.module, from: "1.3.0", to: "1.4.0", canaries: ["live/dev/vpc"], mode: "pull-request" });
    expect(step.outcomeAttribute).toEqual({ name: "Rollout", from: "status" });
    expect(op.schedule).toEqual({ cron: "*/30 * * * *", overlap: "skip" });
  });

  test("its step validates against the activity's contract", () => {
    const op = props({ ...BASE, roots: [{ root: "a" }, { root: "b", dependsOn: ["a"] }] });
    const contracts = new Map([["terraformPinRollout", terraformPinRolloutContract]]);
    expect(validateActivitySteps(op, contracts)).toEqual([]);
  });
});

describe("chant terraform pin-rollout", () => {
  test("is mounted as the terraform group's pin-rollout verb", () => {
    expect(terraformCommands.name).toBe("terraform");
    expect(terraformCommands.commands.map((c) => c.name)).toEqual(["pin-rollout"]);
  });

  test("parses roots, dependencies, a generated root and canaries into the activity's args", () => {
    const { args, json } = parsePinRolloutArgs([
      "--module=oci://r/m/vpc",
      "--from", "1.3.0",
      "--to", "1.4.0",
      "--root", "a",
      "--depends-on", "b=a",
      "--ts-source", "c=c/vpc.ts",
      "--canary", "a",
      "--pull-request",
      "--json",
    ]);
    expect(json).toBe(true);
    expect(args).toEqual({
      module: "oci://r/m/vpc",
      from: "1.3.0",
      to: "1.4.0",
      mode: "pull-request",
      roots: [{ root: "a" }, { root: "b", dependsOn: ["a"] }, { root: "c", tsSource: "c/vpc.ts" }],
      canaries: ["a"],
    });
  });

  test("report is the default mode, and the required flags are required", () => {
    expect(parsePinRolloutArgs(["--module", "m", "--from", "1", "--to", "2"]).args.mode).toBe("report");
    expect(() => parsePinRolloutArgs(["--module", "m", "--from", "1"])).toThrow(/--to is required/);
    expect(() => parsePinRolloutArgs(["--module", "m", "--from", "1", "--to", "2", "--bogus"])).toThrow(/Unknown flag: --bogus/);
  });

  test("waiting exits 3, stopped exits 1, the rest 0", () => {
    expect(["complete", "opened", "would-open", "waiting", "stopped"].map(pinRolloutExitCode)).toEqual([0, 0, 0, 3, 1]);
  });
});
