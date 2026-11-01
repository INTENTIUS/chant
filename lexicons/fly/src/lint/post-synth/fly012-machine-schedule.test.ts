import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { fly012 } from "./fly012-machine-schedule";
import { Machine, MachineConfig } from "../../generated/index";

function ctx(...entries: Array<[string, unknown]>): PostSynthContext {
  const entities = new Map(entries as Array<[string, Declarable]>);
  return {
    outputs: new Map(),
    entities,
    buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("FLY012: machine schedule", () => {
  test("passes each schedule Fly runs, and a Machine with none", () => {
    for (const schedule of ["hourly", "daily", "weekly", "monthly"]) {
      expect(fly012.check(ctx(["dump", new Machine({ config: new MachineConfig({ image: "x", schedule }) })]))).toEqual([]);
    }
    expect(fly012.check(ctx(["web", new Machine({ config: new MachineConfig({ image: "x" }) })]))).toEqual([]);
  });

  test("flags a cron expression", () => {
    const diags = fly012.check(ctx(["dump", new Machine({ config: new MachineConfig({ image: "x", schedule: "0 * * * *" }) })]));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "FLY012", severity: "error", entity: "dump" });
    expect(diags[0].message).toContain("hourly, daily, weekly, monthly");
  });
});
