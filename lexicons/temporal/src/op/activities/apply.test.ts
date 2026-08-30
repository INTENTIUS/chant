import { describe, test, expect } from "vitest";
import { applyResult } from "@intentius/chant/apply";
import { defaultOutput, nativeApply, compensateApply, hasNativeRollback } from "./apply";
import type { K8sApplier, AzureApplier, GcpApplier, FlyApplier, AwsApplier, AwsRollback } from "./apply";

/**
 * The kubectl branch moved to the k8s lexicon in chant #1075, the arm branch to
 * the azure lexicon in #1448, and the cloudformation branch to the aws lexicon
 * in #1449 — no shell target is left. What is asserted here is the dispatch —
 * that a target never becomes a shell command again, that the arguments the
 * composite emits reach each applier intact, and that every branch collapses
 * onto the one normalized result (#1446 counts, collapsed in #1449). What the
 * appliers *do* is their own lexicons' tests.
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
    // The field manager stays on the log; the result is the collapsed counts.
    expect(result).toEqual({ applied: 1, pruned: 0, notAttempted: 0 });
  });

  test("defaultOutput: dist directory", async () => {
    expect(defaultOutput("kustomize")).toBe("dist");
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
    // Counts preserved from the k8s applier's arrays; the k8s contract has no
    // skip path (an unclassifiable document throws), so notAttempted is 0.
    expect(result).toEqual({ applied: 3, pruned: 1, notAttempted: 0 });
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
  /** Records what the applier was handed, and reports an empty envelope. */
  const spy = (): { calls: Array<Parameters<AzureApplier>[0]>; applier: AzureApplier } => {
    const calls: Array<Parameters<AzureApplier>[0]> = [];
    const applier: AzureApplier = async (args) => {
      calls.push(args);
      return applyResult([]);
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
    expect(result).toEqual({ applied: 0, pruned: 0, notAttempted: 0 });
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

  test("counts are preserved from the applier's envelope, not a command", async () => {
    const applier: AzureApplier = async () =>
      applyResult(
        [
          { kind: "Microsoft.Storage/storageAccounts", name: "sa1", action: "updated" },
          { kind: "Microsoft.Network/virtualNetworks", name: "vnet1", action: "updated" },
        ],
        [{ kind: "Microsoft.Storage/storageAccounts", name: "old", deleted: true }],
      );
    const result = await nativeApply({ target: "arm", env: "rg" }, undefined, undefined, applier);
    expect(result).toEqual({ applied: 2, pruned: 1, notAttempted: 0 });
  });

  test("a not-prunable orphan (#1457) surfaces in the notAttempted count", async () => {
    const applier: AzureApplier = async () =>
      applyResult(
        [{ kind: "Microsoft.Storage/storageAccounts", name: "sa1", action: "updated" }],
        [],
        [
          {
            kind: "Microsoft.Custom/widgets",
            name: "w1",
            reason: "not-prunable",
            detail: "no-api-version",
          },
        ],
      );
    const result = await nativeApply(
      { target: "arm", env: "rg", deleteMode: "owned-only" },
      undefined,
      undefined,
      applier,
    );
    expect(result).toEqual({ applied: 1, pruned: 0, notAttempted: 1 });
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

describe("nativeApply: gcp dispatches to the gcp lexicon (chant #1449)", () => {
  /** Records what the applier was handed, and reports an empty envelope. */
  const spy = (): { calls: Array<Parameters<GcpApplier>[0]>; applier: GcpApplier } => {
    const calls: Array<Parameters<GcpApplier>[0]> = [];
    const applier: GcpApplier = async (args) => {
      calls.push(args);
      return applyResult([]);
    };
    return { calls, applier };
  };
  /** nativeApply with only the gcp applier injected. */
  const applyGcp = (args: Parameters<typeof nativeApply>[0], applier: GcpApplier) =>
    nativeApply(args, undefined, undefined, undefined, undefined, undefined, applier);

  test("output maps to the manifest path, and nothing else is passed", async () => {
    const { calls, applier } = spy();
    await applyGcp({ target: "gcp", env: "prod", output: "dist/gcp.yaml" }, applier);
    // Exactly the mapped pair. No `endpoint` — gcpApply resolves
    // GCP_ENDPOINT_URL itself, the same variable its read path honours; no
    // `project` — gcpApply resolves GOOGLE_CLOUD_PROJECT / the CNRM
    // annotation itself; and no `env` — GCP has no stack or resource-group
    // equivalent, so env is only a log label on this target.
    expect(calls).toEqual([{ manifestPath: "dist/gcp.yaml", prune: false }]);
  });

  test("owned-only asks the gcp applier to prune, and issues no shell command", async () => {
    const { calls, applier } = spy();
    await applyGcp({ target: "gcp", env: "prod", deleteMode: "owned-only" }, applier);
    expect(calls[0].prune).toBe(true);
  });

  test("gated prunes too — same delete scope, the gate lives in the composite", async () => {
    const { calls, applier } = spy();
    await applyGcp({ target: "gcp", env: "prod", deleteMode: "gated" }, applier);
    expect(calls[0].prune).toBe(true);
  });

  test("never (and the default) do not prune", async () => {
    const explicit = spy();
    await applyGcp({ target: "gcp", env: "prod", deleteMode: "never" }, explicit.applier);
    expect(explicit.calls[0].prune).toBe(false);

    const defaulted = spy();
    await applyGcp({ target: "gcp", env: "prod" }, defaulted.applier);
    expect(defaulted.calls[0].prune).toBe(false);
  });

  test("defaults the manifest path to dist/gcp.yaml", async () => {
    const { calls, applier } = spy();
    await applyGcp({ target: "gcp", env: "prod" }, applier);
    expect(calls[0].manifestPath).toBe("dist/gcp.yaml");
    expect(defaultOutput("gcp")).toBe("dist/gcp.yaml");
  });

  test("counts are preserved from the applier's envelope, skips included (#1447)", async () => {
    // The skips of #1447 and a kind the prune could not consider both ride the
    // envelope as NOT-ATTEMPTED entries — the old separate notPrunable count
    // folds into the one notAttempted count.
    const applier: GcpApplier = async () =>
      applyResult(
        [
          { kind: "StorageBucket", name: "b1", action: "created" },
          { kind: "StorageBucket", name: "b2", action: "unchanged" },
        ],
        [{ kind: "StorageBucket", name: "old", deleted: true }],
        [
          { kind: "PubSubTopic", name: "x", reason: "unsupported-kind" },
          { kind: "PubSubTopic", name: "*", reason: "not-prunable", detail: "no-list-capability" },
        ],
      );
    const result = await applyGcp({ target: "gcp", env: "prod" }, applier);
    expect(result).toEqual({ applied: 2, pruned: 1, notAttempted: 2 });
  });

  test("with nothing injected it resolves the real gcp lexicon's gcpApply", async () => {
    // Same shape as the kubectl and cloudformation cases: a manifest path that
    // does not exist fails inside gcpApply's own manifest read — reachable only
    // if the dynamic import found the lexicon — and it fails before any HTTP
    // call, so nothing goes near GCP or an emulator.
    const err = await nativeApply({
      target: "gcp",
      env: "prod",
      output: "/nonexistent/chant-1449-gcp.yaml",
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/ENOENT|no such file/);
    expect(String(err)).not.toMatch(/could not be loaded/);
  });
});

describe("nativeApply: fly dispatches to the fly lexicon (chant #1449)", () => {
  /** Records what the applier was handed, and reports an empty envelope. */
  const spy = (): { calls: Array<Parameters<FlyApplier>[0]>; applier: FlyApplier } => {
    const calls: Array<Parameters<FlyApplier>[0]> = [];
    const applier: FlyApplier = async (args) => {
      calls.push(args);
      return applyResult([]);
    };
    return { calls, applier };
  };
  /** nativeApply with only the fly applier injected. */
  const applyFly = (args: Parameters<typeof nativeApply>[0], applier: FlyApplier) =>
    nativeApply(args, undefined, undefined, undefined, undefined, undefined, undefined, applier);

  test("output maps to the plan path, and nothing else is passed", async () => {
    const { calls, applier } = spy();
    await applyFly({ target: "fly", env: "prod", output: "dist/fly.json" }, applier);
    // Exactly the mapped pair. No `endpoint` — flyApply resolves
    // FLY_FLAPS_BASE_URL itself (mudflaps locally, real Fly when unset); no
    // `token` — it resolves FLY_API_TOKEN itself; and no `env` — the app
    // names live in the plan, so env is only a log label on this target.
    expect(calls).toEqual([{ planPath: "dist/fly.json", prune: false }]);
  });

  test("owned-only asks the fly applier to prune, and issues no shell command", async () => {
    const { calls, applier } = spy();
    await applyFly({ target: "fly", env: "prod", deleteMode: "owned-only" }, applier);
    expect(calls[0].prune).toBe(true);
  });

  test("gated prunes too — same delete scope, the gate lives in the composite", async () => {
    const { calls, applier } = spy();
    await applyFly({ target: "fly", env: "prod", deleteMode: "gated" }, applier);
    expect(calls[0].prune).toBe(true);
  });

  test("never (and the default) do not prune", async () => {
    const explicit = spy();
    await applyFly({ target: "fly", env: "prod", deleteMode: "never" }, explicit.applier);
    expect(explicit.calls[0].prune).toBe(false);

    const defaulted = spy();
    await applyFly({ target: "fly", env: "prod" }, defaulted.applier);
    expect(defaulted.calls[0].prune).toBe(false);
  });

  test("defaults the plan path to dist/fly.json", async () => {
    const { calls, applier } = spy();
    await applyFly({ target: "fly", env: "prod" }, applier);
    expect(calls[0].planPath).toBe("dist/fly.json");
    expect(defaultOutput("fly")).toBe("dist/fly.json");
  });

  test("counts are preserved from the applier's envelope", async () => {
    // The six applied classes and five pruned classes are flattened into the
    // envelope by fly's own toApplyResult (tested in the fly lexicon); this
    // dispatcher only carries the counts through.
    const applier: FlyApplier = async () =>
      applyResult(
        [
          { kind: "app", name: "web", action: "created" },
          { kind: "machine", name: "web-1", action: "created" },
          { kind: "machine", name: "web-2", action: "updated" },
          { kind: "volume", name: "data", action: "unchanged" },
          { kind: "ip", name: "v4", action: "created" },
          { kind: "cert", name: "example.com", action: "created" },
          { kind: "secret", name: "API_KEY", action: "updated" },
        ],
        [
          { kind: "machine", name: "old-1", deleted: true },
          { kind: "volume", name: "old-data", deleted: true },
          { kind: "ip", name: "1.2.3.4", deleted: true },
          { kind: "cert", name: "old.example.com", deleted: true },
          { kind: "secret", name: "OLD_KEY", deleted: true },
        ],
      );
    const result = await applyFly({ target: "fly", env: "prod" }, applier);
    expect(result).toEqual({ applied: 7, pruned: 5, notAttempted: 0 });
  });

  test("with nothing injected it resolves the real fly lexicon's flyApply", async () => {
    // Same shape as the kubectl and cloudformation cases: a plan path that does
    // not exist fails inside flyApply's own plan read — reachable only if the
    // dynamic import found the lexicon — and it fails before any HTTP call, so
    // nothing goes near Fly or an emulator.
    const err = await nativeApply({
      target: "fly",
      env: "prod",
      output: "/nonexistent/chant-1449-fly.json",
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/ENOENT|no such file/);
    expect(String(err)).not.toMatch(/could not be loaded/);
  });
});

describe("nativeApply: cloudformation dispatches to the aws lexicon (chant #1449)", () => {
  /** Records what the applier was handed, and reports a settled create. */
  const spy = (): { calls: Array<Parameters<AwsApplier>[0]>; applier: AwsApplier } => {
    const calls: Array<Parameters<AwsApplier>[0]> = [];
    const applier: AwsApplier = async (args) => {
      calls.push(args);
      return { stackName: args.stackName, status: "CREATE_COMPLETE", action: "created" };
    };
    return { calls, applier };
  };
  /** nativeApply with only the aws applier injected. */
  const applyCfn = (args: Parameters<typeof nativeApply>[0], applier: AwsApplier) =>
    nativeApply(args, undefined, undefined, undefined, undefined, applier);

  test("env maps to the stack name and output to the template path, and nothing else is passed", async () => {
    const { calls, applier } = spy();
    await applyCfn({ target: "cloudformation", env: "prod", output: "stack.json" }, applier);
    // Exactly the mapped pair. No `capabilities` — awsApply derives them from
    // the template body (#980, `awsDeployCapabilitiesForBody`); no `endpoint` —
    // awsApply resolves AWS_ENDPOINT_URL[_CLOUDFORMATION] itself (#1694). Both
    // rules used to be duplicated here as `cfnCapabilities`/`applyEndpoint`.
    expect(calls).toEqual([{ templatePath: "stack.json", stackName: "prod" }]);
  });

  test("defaults the template path to template.json", async () => {
    const { calls, applier } = spy();
    await applyCfn({ target: "cloudformation", env: "prod" }, applier);
    expect(calls[0].templatePath).toBe("template.json");
    expect(defaultOutput("cloudformation")).toBe("template.json");
  });

  test("deleteMode changes nothing — the stack IS the ownership boundary", async () => {
    // CFN removes resources dropped from the template within the stack itself,
    // so owned-only and never hand the applier identical arguments.
    const owned = spy();
    await applyCfn({ target: "cloudformation", env: "prod", deleteMode: "owned-only" }, owned.applier);
    const never = spy();
    await applyCfn({ target: "cloudformation", env: "prod", deleteMode: "never" }, never.applier);
    expect(owned.calls).toEqual(never.calls);
  });

  test("collapses onto the normalized counts — the stack is the unit", async () => {
    // The stack name, settled status and action are the operator's detail and
    // stay on the activity log; the result is the same count shape as every
    // other target's. One settled deploy is one applied.
    const applier: AwsApplier = async () => ({ stackName: "prod", status: "UPDATE_COMPLETE", action: "updated" });
    const result = await applyCfn({ target: "cloudformation", env: "prod" }, applier);
    expect(result).toEqual({ applied: 1, pruned: 0, notAttempted: 0 });
  });

  test("with nothing injected it resolves the real aws lexicon's awsApply", async () => {
    // Same shape as the kubectl case: a template path that does not exist fails
    // inside awsApply's own template read — reachable only if the dynamic
    // import found the lexicon — and it fails before any HTTP call, so nothing
    // goes near AWS or an emulator.
    const err = await nativeApply({
      target: "cloudformation",
      env: "prod",
      output: "/nonexistent/chant-1449-template.json",
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/ENOENT|no such file/);
    expect(String(err)).not.toMatch(/could not be loaded/);
  });
});

describe("compensateApply: cloudformation rolls back through the aws lexicon (chant #1449)", () => {
  test("calls rollbackStack with the env as the stack name, and execs nothing", async () => {
    const calls: Array<Parameters<AwsRollback>[0]> = [];
    const rollback: AwsRollback = async (args) => {
      calls.push(args);
      return { stackName: args.stackName, rolledBack: true, status: "UPDATE_ROLLBACK_COMPLETE" };
    };
    const result = await compensateApply({ target: "cloudformation", env: "prod" }, undefined, rollback);
    expect(calls).toEqual([{ stackName: "prod" }]);
    expect(result).toEqual({ stackName: "prod", rolledBack: true, status: "UPDATE_ROLLBACK_COMPLETE" });
    // A command in the result would mean the shell path ran.
    expect(result.command).toBeUndefined();
  });

  test("a declined rollback (absent stack, or Floci's UnknownAction) is reported, not hidden", async () => {
    const rollback: AwsRollback = async (args) => ({ stackName: args.stackName, rolledBack: false });
    const result = await compensateApply({ target: "cloudformation", env: "prod" }, undefined, rollback);
    expect(result).toEqual({ stackName: "prod", rolledBack: false });
  });

  test("an explicit command takes precedence over the native rollback", async () => {
    let rolled = false;
    const rollback: AwsRollback = async (args) => {
      rolled = true;
      return { stackName: args.stackName, rolledBack: true };
    };
    const result = await compensateApply(
      { target: "cloudformation", env: "prod", command: "echo custom-rollback" },
      undefined,
      rollback,
    );
    expect(rolled).toBe(false);
    expect(result).toEqual({ command: "echo custom-rollback" });
  });

  test("kubectl / kustomize / arm / gcp / fly without a command throw — the defensive branch (#1449)", async () => {
    // Unreachable from a built ApplyOp, which refuses this combination at
    // build time. A hand-assembled op that reaches it fails loudly rather than
    // returning a result that could read as a revert.
    for (const target of ["kubectl", "kustomize", "arm", "gcp", "fly"] as const) {
      const err = await compensateApply({ target, env: "prod" }).catch((e: unknown) => e);
      expect(String(err)).toMatch(`no automatic rollback for target "${target}"`);
      expect(String(err)).toMatch(/NOT\s+reverted/);
      expect(String(err)).toMatch(/compensate\.command/);
    }
  });

  test("hasNativeRollback: cloudformation only", () => {
    expect(hasNativeRollback("cloudformation")).toBe(true);
    for (const target of ["kubectl", "kustomize", "arm", "gcp", "fly"] as const) {
      expect(hasNativeRollback(target)).toBe(false);
    }
  });

  test("an explicit command still runs for targets without a native rollback", async () => {
    const result = await compensateApply({ target: "arm", env: "rg", command: "echo arm-rollback" });
    expect(result).toEqual({ command: "echo arm-rollback" });
  });

  test("with nothing injected it resolves the real aws lexicon's rollbackStack", async () => {
    // Point the endpoint at a closed local port so the failure comes from inside
    // rollbackStack's own transport — reachable only if the dynamic import found
    // the lexicon — and never touches real AWS.
    const prev = process.env.AWS_ENDPOINT_URL;
    process.env.AWS_ENDPOINT_URL = "http://127.0.0.1:1";
    try {
      const err = await compensateApply({ target: "cloudformation", env: "prod" }).catch((e: unknown) => e);
      expect(String(err)).not.toMatch(/could not be loaded/);
      expect(String(err)).not.toMatch(/predates chant/);
    } finally {
      if (prev === undefined) delete process.env.AWS_ENDPOINT_URL;
      else process.env.AWS_ENDPOINT_URL = prev;
    }
  });
});

describe('defaultOutput (target-aware apply output)', () => {
  test('kubectl → dist (dir); cloudformation/arm → template.json (file); gcp → dist/gcp.yaml; fly → dist/fly.json', () => {
    expect(defaultOutput('kubectl')).toBe('dist');
    expect(defaultOutput('cloudformation')).toBe('template.json');
    expect(defaultOutput('arm')).toBe('template.json');
    expect(defaultOutput('gcp')).toBe('dist/gcp.yaml');
    expect(defaultOutput('fly')).toBe('dist/fly.json');
  });
});
