import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { checkDuplicateLicenses, slr032 } from "./slr032-duplicate-licenses";

function makeCtx(conf: string): PostSynthContext {
  return {
    outputs: new Map([["slurm", conf]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["slurm", conf]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("SLR032: Duplicate Licenses= declarations", () => {
  test("check metadata", () => {
    expect(slr032.id).toBe("SLR032");
    expect(slr032.description).toContain("Licenses=");
  });

  test("fires when Licenses= appears more than once", () => {
    const conf = [
      "ClusterName=test",
      "Licenses=eda_synth:50,eda_sim:200",
      "NodeName=cpu[001-016] CPUs=36 State=CLOUD",
      "",
      "Licenses=eda_sim:200,eda_synth:50",
    ].join("\n");
    const diags = checkDuplicateLicenses(conf);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("SLR032");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("2 Licenses=");
  });

  test("no fire with exactly one Licenses= line", () => {
    const conf = [
      "ClusterName=test",
      "NodeName=cpu[001-016] CPUs=36 State=CLOUD",
      "Licenses=eda_synth:50",
    ].join("\n");
    expect(checkDuplicateLicenses(conf)).toHaveLength(0);
  });

  test("no fire with no Licenses= line", () => {
    const conf = ["ClusterName=test", "NodeName=cpu[001-016] CPUs=36 State=CLOUD"].join("\n");
    expect(checkDuplicateLicenses(conf)).toHaveLength(0);
  });

  test("check() via PostSynthContext", () => {
    const conf = ["Licenses=a:1", "NodeName=cpu001 CPUs=4 State=CLOUD", "Licenses=a:1"].join("\n");
    expect(slr032.check(makeCtx(conf))).toHaveLength(1);
  });
});
