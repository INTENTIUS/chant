import { describe, test, expect, vi, afterEach } from "vitest";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { runApply } from "./apply";
import type { ApplyManifestResult } from "../op/activities/kubectl";

afterEach(() => vi.restoreAllMocks());

function spyConsole() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { log, error };
}

const RESULT: ApplyManifestResult = {
  fieldManager: "chant",
  applied: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" }],
  pruned: [],
};

describe("chant kube apply (#1079)", () => {
  test("without --yes, applyManifest is called with dryRun and nothing is reported as persisted", async () => {
    const apply = vi.fn().mockResolvedValue(RESULT);
    const connect = vi.fn();
    const { log } = spyConsole();

    const code = await runApply(["-f", "manifest.yaml"], { apply, connect });

    expect(code).toBe(0);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ manifest: "manifest.yaml", dryRun: true }), undefined, connect);
    expect(log.mock.calls[0][0]).toContain("DRY RUN");
    expect(log.mock.calls[0][0]).toContain("--yes");
  });

  test("--yes performs the real apply (dryRun: false) and reports what happened", async () => {
    const apply = vi.fn().mockResolvedValue(RESULT);
    const connect = vi.fn();
    const { log } = spyConsole();

    const code = await runApply(["-f", "manifest.yaml", "--yes"], { apply, connect });

    expect(code).toBe(0);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }), undefined, connect);
    expect(log.mock.calls[0][0]).toContain("applied 1 object(s)");
  });

  test("an explicit manifest is mandatory — no bare sweeps", async () => {
    const apply = vi.fn();
    const { error } = spyConsole();

    const code = await runApply([], { apply });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("--filename/-f is required");
    expect(apply).not.toHaveBeenCalled();
  });

  test("binding mismatch refuses loudly, rendered as NOT-OBSERVED", async () => {
    const apply = vi.fn().mockRejectedValue(new ClusterBindingMismatchError("prod", "prod-eks", "dev-eks"));
    const { error } = spyConsole();

    const code = await runApply(["-f", "manifest.yaml", "--env", "prod", "--yes"], { apply });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no binding for this environment");
  });

  test("unknown flag is rejected before apply runs", async () => {
    const apply = vi.fn();
    const { error } = spyConsole();

    const code = await runApply(["-f", "manifest.yaml", "--bogus"], { apply });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("Unknown flag");
    expect(apply).not.toHaveBeenCalled();
  });

  test("a field-manager conflict renders the same conflict surface the Op activity produces, not a raw 409", async () => {
    class FieldManagerConflictError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "FieldManagerConflictError";
      }
    }
    const apply = vi.fn().mockRejectedValue(new FieldManagerConflictError('k8s: server-side apply of apps/v1 Deployment prod/web was refused'));
    const { error } = spyConsole();

    const code = await runApply(["-f", "manifest.yaml", "--yes"], { apply });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("was refused");
  });

  test("tri-state: a transport failure renders NOT-OBSERVED, not a silent no-op", async () => {
    const err = new Error("connect ECONNREFUSED");
    (err as { name?: string }).name = "K8sTransportError";
    const apply = vi.fn().mockRejectedValue(err);
    const { error } = spyConsole();

    const code = await runApply(["-f", "manifest.yaml", "--yes"], { apply });

    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("no binding for this environment");
  });
});
