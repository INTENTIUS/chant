import { describe, expect, test } from "vitest";
import { validateActivitySteps, type ActivityStep, type OpConfig } from "@intentius/chant/op";
import { PulumiWatchOp } from "./pulumi-watch-op";
import { pulumiDriftContract, pulumiPreviewContract } from "../op/activity-contracts";
import * as activities from "../op/activities";

function props(config: Parameters<typeof PulumiWatchOp>[0]): OpConfig {
  return (PulumiWatchOp(config).op as unknown as { props: OpConfig }).props;
}

const BASE = { name: "infra-watch", member: "infra", dir: "./infra" };
const contracts = new Map([
  ["pulumiPreview", pulumiPreviewContract],
  ["pulumiDrift", pulumiDriftContract],
]);

describe("PulumiWatchOp (#4494)", () => {
  test("Preview then Drift, each publishing its outcome", () => {
    const op = props({ ...BASE, stack: "dev", schedule: "0 6 * * *" });
    expect(op.phases.map((p) => p.name)).toEqual(["Preview", "Drift"]);
    const [preview, drift] = op.phases.map((p) => p.steps[0] as ActivityStep);
    expect(preview!.fn).toBe("pulumiPreview");
    expect(preview!.args).toEqual({ member: "infra", dir: "./infra", stack: "dev" });
    expect(preview!.outcomeAttribute).toEqual({ name: "Changes", from: "changed" });
    expect(drift!.fn).toBe("pulumiDrift");
    expect(drift!.outcomeAttribute).toEqual({ name: "Drift", from: "drifted" });
    expect(op.schedule).toEqual({ cron: "0 6 * * *", overlap: "skip" });
  });

  test("drift: false leaves the Drift phase out", () => {
    expect(props({ ...BASE, drift: false }).phases.map((p) => p.name)).toEqual(["Preview"]);
  });

  test("its steps validate against the activities' contracts", () => {
    expect(validateActivitySteps(props({ ...BASE, engine: "plunge" }), contracts)).toEqual([]);
  });

  test("the activities module exports exactly the two activities", () => {
    const fns = Object.entries(activities).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
    expect(fns).toEqual(["pulumiDrift", "pulumiPreview"]);
  });
});
