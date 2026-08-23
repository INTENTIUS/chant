import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand, cfnCapabilities, rollbackCommand, defaultOutput, applyEndpoint, nativeApply } from "./apply";
import type { K8sApplier, AzureApplier } from "./apply";

describe("cfnCapabilities (#980)", () => {
  const dir = mkdtempSync(join(tmpdir(), "chant-cfn-caps-"));
  const write = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  test("plain template, missing file, or non-JSON → CAPABILITY_NAMED_IAM only", () => {
    expect(cfnCapabilities(write("plain.json", JSON.stringify({ Resources: {} })))).toBe("CAPABILITY_NAMED_IAM");
    expect(cfnCapabilities(join(dir, "absent.json"))).toBe("CAPABILITY_NAMED_IAM");
    expect(cfnCapabilities(write("plain.yaml", "Resources: {}\n"))).toBe("CAPABILITY_NAMED_IAM");
  });

  test("a top-level Transform (string or list) → adds CAPABILITY_AUTO_EXPAND", () => {
    const str = write("str.json", JSON.stringify({ Transform: "AWS::SecretsManager-2020-07-23", Resources: {} }));
    const list = write("list.json", JSON.stringify({ Transform: ["AWS::LanguageExtensions"], Resources: {} }));
    expect(cfnCapabilities(str)).toBe("CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND");
    expect(cfnCapabilities(list)).toBe("CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND");
    expect(applyCommand("cloudformation", "prod", str, "never")).toContain(
      "--capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyCommand (#124)", () => {
  test("cloudformation deploys to the env stack", () => {
    const cmd = applyCommand("cloudformation", "prod", "stack.json", "owned-only");
    expect(cmd).toContain("aws cloudformation deploy");
    expect(cmd).toContain("--stack-name prod");
    expect(cmd).toContain("--template-file stack.json");
  });

  // Replaces "arm uses Complete mode only when deleting" (#1448). That test
  // asserted the bug: `az deployment group create --mode Complete` deletes every
  // resource in the group absent from the template, chant-owned or not, while
  // this module's docblock promised deletes were "limited to chant-owned orphans
  // by construction". arm no longer produces a command at all.
  test("cloudformation is the only shell target left", () => {
    // `deleteMode` changes nothing for CFN: the stack IS the ownership boundary,
    // so `deploy` can only remove resources chant put in it.
    const owned = applyCommand("cloudformation", "prod", "stack.json", "owned-only");
    const never = applyCommand("cloudformation", "prod", "stack.json", "never");
    expect(owned).toBe(never);
    expect(owned).not.toContain("--mode");
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
    // A non-cloudformation target passes through untouched. Written against a
    // literal rather than `applyCommand("arm", …)`, which since #1448 returns
    // undefined — comparing that to itself asserted nothing.
    const arm = "az deployment group create --resource-group rg";
    expect(applyEndpoint(arm, "arm", url)).toBe(arm);
    expect(applyEndpoint("kubectl apply -f dist", "kubectl", url)).toBe("kubectl apply -f dist");
  });
});

/**
 * The kubectl branch moved to the k8s lexicon in chant #1075. What is asserted
 * here is the dispatch — that a kubectl target never becomes a shell command
 * again, and that the arguments the composite emits reach the applier intact.
 * What the applier *does* is the k8s lexicon's own test.
 */
describe("nativeApply: kustomize renders, then dispatches to the SAME k8s applier (#1548)", () => {
  test("the rendered documents reach the applier inline, output as the render dir", async () => {
    const calls: Parameters<K8sApplier>[0][] = [];
    const k8s: K8sApplier = async (args) => {
      calls.push(args);
      return { applied: [{}], pruned: [], fieldManager: "chant:web" };
    };
    const rendered = [{ apiVersion: "v1", kind: "Namespace", metadata: { name: "web" } }];
    const renderer = async (dir: string) => {
      expect(dir).toBe("overlays/prod");
      return rendered;
    };

    const result = await nativeApply(
      { target: "kustomize", env: "prod", output: "overlays/prod", deleteMode: "owned-only" },
      undefined,
      k8s,
      undefined,
      renderer,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].documents).toBe(rendered);
    expect(calls[0].manifest).toBe("kustomize:overlays/prod"); // label, not a path
    expect(calls[0].deleteMode).toBe("owned-only");
    expect(result.applied).toBe(1);
    expect(result.fieldManager).toBe("chant:web");
  });

  test("defaultOutput and rollback: dist directory, no native rollback", async () => {
    expect(defaultOutput("kustomize")).toBe("dist");
    expect(rollbackCommand("kustomize", "prod")).toBeUndefined();
  });
});

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

describe("nativeApply: arm dispatches to the azure lexicon (chant #1448)", () => {
  /** Records what the applier was handed, and reports nothing applied. */
  const spy = (): { calls: Array<Parameters<AzureApplier>[0]>; applier: AzureApplier } => {
    const calls: Array<Parameters<AzureApplier>[0]> = [];
    const applier: AzureApplier = async (args) => {
      calls.push(args);
      return { applied: [], pruned: [] };
    };
    return { calls, applier };
  };

  // The fix. `owned-only` must reach azApply's marker-scoped prune, which filters
  // on `isChantOwned(tags)` before issuing any delete — not ARM Complete mode,
  // whose scope is the entire resource group.
  test("owned-only asks the azure applier to prune, and issues no shell command", async () => {
    const { calls, applier } = spy();
    const result = await nativeApply(
      { target: "arm", env: "my-rg", output: "t.json", deleteMode: "owned-only" },
      undefined,
      undefined,
      applier,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].prune).toBe(true);
    expect(calls[0].resourceGroup).toBe("my-rg");
    expect(calls[0].templatePath).toBe("t.json");
    // A command here would mean the shell path ran — the thing #1448 is about.
    expect(result.command).toBeUndefined();
  });

  test("gated prunes too — same delete scope, the gate lives in the composite", async () => {
    const { calls, applier } = spy();
    await nativeApply({ target: "arm", env: "rg", deleteMode: "gated" }, undefined, undefined, applier);
    expect(calls[0].prune).toBe(true);
  });

  test("never does not prune", async () => {
    const { calls, applier } = spy();
    await nativeApply({ target: "arm", env: "rg", deleteMode: "never" }, undefined, undefined, applier);
    expect(calls[0].prune).toBe(false);
  });

  test("defaults to never when no delete mode is given", async () => {
    const { calls, applier } = spy();
    await nativeApply({ target: "arm", env: "rg" }, undefined, undefined, applier);
    expect(calls[0].prune).toBe(false);
  });

  test("defaults the template path the same way the other file targets do", async () => {
    const { calls, applier } = spy();
    await nativeApply({ target: "arm", env: "rg" }, undefined, undefined, applier);
    expect(calls[0].templatePath).toBe("template.json");
  });

  // Same variable azure's read path honours, so an apply lands wherever `--live`
  // is already looking.
  test("passes AZURE_ENDPOINT_URL through, and omits it when unset", async () => {
    const prev = process.env.AZURE_ENDPOINT_URL;
    try {
      process.env.AZURE_ENDPOINT_URL = "http://localhost:4577";
      const a = spy();
      await nativeApply({ target: "arm", env: "rg" }, undefined, undefined, a.applier);
      expect(a.calls[0].endpoint).toBe("http://localhost:4577");

      delete process.env.AZURE_ENDPOINT_URL;
      const b = spy();
      await nativeApply({ target: "arm", env: "rg" }, undefined, undefined, b.applier);
      expect(b.calls[0].endpoint).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AZURE_ENDPOINT_URL;
      else process.env.AZURE_ENDPOINT_URL = prev;
    }
  });

  test("reports what was applied and pruned, not a command", async () => {
    const applier: AzureApplier = async () => ({ applied: [{}, {}], pruned: [{}] });
    const result = await nativeApply({ target: "arm", env: "rg" }, undefined, undefined, applier);
    expect(result).toEqual({ applied: 2, pruned: 1 });
  });

  test("with nothing injected it resolves the real azure lexicon's azApply", async () => {
    // Same shape as the kubectl case above: point it at a closed local port so
    // the failure comes from inside azApply's own transport — reachable only if
    // the dynamic import found the lexicon — and never touches real Azure.
    const prev = process.env.AZURE_ENDPOINT_URL;
    process.env.AZURE_ENDPOINT_URL = "http://127.0.0.1:1";
    try {
      const err = await nativeApply({ target: "arm", env: "rg" }).catch((e: unknown) => e);
      expect(String(err)).not.toMatch(/could not be loaded/);
      expect(String(err)).not.toMatch(/predates chant/);
    } finally {
      if (prev === undefined) delete process.env.AZURE_ENDPOINT_URL;
      else process.env.AZURE_ENDPOINT_URL = prev;
    }
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
