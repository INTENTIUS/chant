import { describe, test, expect } from "vitest";
import { applyCommand, rollbackCommand, defaultOutput, applyEndpoint, nativeApply } from "./apply";
import type { K8sApplier } from "./apply";

describe("applyCommand (#124)", () => {
  test("cloudformation deploys to the env stack", () => {
    const cmd = applyCommand("cloudformation", "prod", "stack.json", "owned-only");
    expect(cmd).toContain("aws cloudformation deploy");
    expect(cmd).toContain("--stack-name prod");
    expect(cmd).toContain("--template-file stack.json");
  });

  test("arm uses Complete mode only when deleting", () => {
    expect(applyCommand("arm", "rg", "t.json", "owned-only")).toContain("--mode Complete");
    expect(applyCommand("arm", "rg", "t.json", "never")).toContain("--mode Incremental");
  });
});

describe("applyEndpoint (#926)", () => {
  const url = "http://localhost:4566";

  test("injects --endpoint-url into the cloudformation deploy when an endpoint is set", () => {
    const cmd = applyEndpoint(applyCommand("cloudformation", "prod", "template.json", "never"), "cloudformation", url);
    expect(cmd).toBe(
      `aws --endpoint-url '${url}' cloudformation deploy --template-file template.json --stack-name prod --capabilities CAPABILITY_NAMED_IAM`,
    );
  });

  test("passes through with no endpoint, or for non-cloudformation targets", () => {
    const cfn = applyCommand("cloudformation", "prod", "template.json", "never");
    expect(applyEndpoint(cfn, "cloudformation", undefined)).toBe(cfn);
    expect(applyEndpoint(cfn, "cloudformation", "")).toBe(cfn);
    const arm = applyCommand("arm", "rg", "t.json", "never");
    expect(applyEndpoint(arm, "arm", url)).toBe(arm);
  });
});

/**
 * The kubectl branch moved to the k8s lexicon in chant #1075. What is asserted
 * here is the dispatch — that a kubectl target never becomes a shell command
 * again, and that the arguments the composite emits reach the applier intact.
 * What the applier *does* is the k8s lexicon's own test.
 */
describe("nativeApply: kubectl dispatches to the k8s lexicon (chant #1075)", () => {
  const applier = (): { fn: K8sApplier; calls: Parameters<K8sApplier>[0][] } => {
    const calls: Parameters<K8sApplier>[0][] = [];
    return {
      calls,
      fn: async (args) => {
        calls.push(args);
        return { applied: [{}, {}, {}], pruned: [{}], fieldManager: "chant:web" };
      },
    };
  };

  test("passes the manifest, environment and delete mode through, and reports what happened", async () => {
    const k8s = applier();
    const result = await nativeApply(
      { target: "kubectl", env: "prod", output: "dist", deleteMode: "owned-only" },
      undefined,
      k8s.fn,
    );

    expect(k8s.calls).toEqual([
      { manifest: "dist", environment: "prod", deleteMode: "owned-only" },
    ]);
    expect(result).toEqual({ applied: 3, pruned: 1, fieldManager: "chant:web" });
    // The result is not a shell command, because no shell ran.
    expect(result.command).toBeUndefined();
  });

  test("defaults the output to `dist` and the delete mode to never", async () => {
    const k8s = applier();
    await nativeApply({ target: "kubectl", env: "prod" }, undefined, k8s.fn);
    expect(k8s.calls[0]).toMatchObject({ manifest: "dist", deleteMode: "never" });
  });

  test("force-conflicts is absent unless the caller asked for it", async () => {
    const off = applier();
    await nativeApply({ target: "kubectl", env: "prod" }, undefined, off.fn);
    expect(off.calls[0].force).toBeUndefined();

    const on = applier();
    await nativeApply({ target: "kubectl", env: "prod", forceConflicts: true }, undefined, on.fn);
    expect(on.calls[0].force).toBe(true);
  });

  test("there is no kubectl shell command left to fall back to", () => {
    // `applyCommand` only takes the shell targets now — the type says so, and
    // at runtime a kubectl target falls off the end of the switch rather than
    // producing `kubectl apply -f`. Nothing can shell out for kubectl again
    // without this failing first.
    const shellCommandForKubectl = (applyCommand as unknown as (
      t: string,
      e: string,
      o: string,
      d: string,
    ) => string | undefined)("kubectl", "prod", "dist", "owned-only");
    expect(shellCommandForKubectl).toBeUndefined();
  });

  test("with nothing injected it resolves the real k8s lexicon's applyManifest", async () => {
    // The delegation itself, not a stand-in for it. A manifest path that does
    // not exist fails inside the k8s activity's own manifest read, which is
    // only reachable if the dynamic import found the lexicon — and it fails
    // before any connector runs, so nothing goes near a cluster.
    const err = await nativeApply({
      target: "kubectl",
      env: "prod",
      output: "/nonexistent/chant-1075-manifest",
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/ENOENT|no such file/);
    expect(String(err)).not.toMatch(/could not be loaded/);
  });
});

describe("rollbackCommand (#125)", () => {
  test("cloudformation has a native rollback", () => {
    expect(rollbackCommand("cloudformation", "prod")).toBe(
      "aws cloudformation rollback-stack --stack-name prod",
    );
  });

  test("kubectl / arm have no native single-command rollback", () => {
    expect(rollbackCommand("kubectl", "prod")).toBeUndefined();
    expect(rollbackCommand("arm", "rg")).toBeUndefined();
  });
});

describe('defaultOutput (target-aware apply output)', () => {
  test('kubectl → dist (dir); cloudformation/arm → template.json (file)', () => {
    expect(defaultOutput('kubectl')).toBe('dist');
    expect(defaultOutput('cloudformation')).toBe('template.json');
    expect(defaultOutput('arm')).toBe('template.json');
  });
});
