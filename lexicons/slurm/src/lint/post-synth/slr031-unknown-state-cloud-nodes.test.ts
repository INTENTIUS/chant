import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { checkUnknownStateCloudNodes, slr031 } from "./slr031-unknown-state-cloud-nodes";

function makeCtx(conf: string): PostSynthContext {
  return {
    outputs: new Map([["slurm", conf]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["slurm", conf]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("SLR031: Node State=UNKNOWN with SuspendProgram", () => {
  test("check metadata", () => {
    expect(slr031.id).toBe("SLR031");
    expect(slr031.description).toContain("UNKNOWN");
  });

  test("fires when SuspendProgram set and node has State=UNKNOWN", () => {
    const conf = [
      "ClusterName=test",
      "SuspendProgram=/usr/local/bin/slurm_suspend",
      "ResumeProgram=/usr/local/bin/slurm_resume",
      "NodeName=gpu[001-004] CPUs=96 RealMemory=1044480 Gres=gpu:a100:8 State=UNKNOWN",
    ].join("\n");
    const diags = checkUnknownStateCloudNodes(conf);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("SLR031");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("gpu[001-004]");
    expect(diags[0].message).toContain("CLOUD");
  });

  test("no fire when SuspendProgram set and node has State=CLOUD", () => {
    const conf = [
      "ClusterName=test",
      "SuspendProgram=/usr/local/bin/slurm_suspend",
      "NodeName=gpu[001-004] CPUs=96 State=CLOUD",
    ].join("\n");
    expect(checkUnknownStateCloudNodes(conf)).toHaveLength(0);
  });

  test("no fire when no SuspendProgram", () => {
    const conf = [
      "ClusterName=test",
      "NodeName=gpu[001-004] CPUs=96 State=UNKNOWN",
    ].join("\n");
    expect(checkUnknownStateCloudNodes(conf)).toHaveLength(0);
  });

  test("fires once per UNKNOWN node", () => {
    const conf = [
      "SuspendProgram=/x",
      "NodeName=gpu[001-004] CPUs=96 State=UNKNOWN",
      "NodeName=gpu[005-008] CPUs=96 State=UNKNOWN",
      "NodeName=cpu[001-016] CPUs=36 State=CLOUD",
    ].join("\n");
    const diags = checkUnknownStateCloudNodes(conf);
    expect(diags).toHaveLength(2);
  });

  test("check() via PostSynthContext", () => {
    const conf = [
      "SuspendProgram=/x",
      "NodeName=gpu[001-004] CPUs=96 State=UNKNOWN",
    ].join("\n");
    const diags = slr031.check(makeCtx(conf));
    expect(diags).toHaveLength(1);
  });
});
