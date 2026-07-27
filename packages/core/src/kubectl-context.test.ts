import { describe, test, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      Promise.resolve(execMock(cmd)).then(
        (out) => cb(null, out as { stdout: string; stderr: string }),
        (err) => cb(err as Error, { stdout: "", stderr: "" }),
      );
    },
  };
});

const { resolveClusterTarget, ClusterBindingMismatchError } = await import("./kubectl-context");

describe("resolveClusterTarget (chant #1100)", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test("no binding declared: returns ambient source, warns visibly, never probes kubectl", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const target = await resolveClusterTarget({}, "prod", "k8s");

    expect(target).toEqual({ source: "ambient" });
    expect(execMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[k8s\].*environment "prod".*k8s\.profiles\.prod\.context/s),
    );
    warnSpy.mockRestore();
  });

  test("bound and ambient context matches: returns the bound context", async () => {
    execMock.mockResolvedValue({ stdout: "prod-eks\n", stderr: "" });

    const target = await resolveClusterTarget(
      { k8s: { profiles: { prod: { context: "prod-eks" } } } },
      "prod",
      "k8s",
    );

    expect(target).toEqual({ context: "prod-eks", source: "bound" });
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining("current-context"));
  });

  test("bound and ambient context cannot be determined: proceeds with the bound context anyway", async () => {
    execMock.mockRejectedValue(new Error("no kubeconfig"));

    const target = await resolveClusterTarget(
      { k8s: { profiles: { prod: { context: "prod-eks" } } } },
      "prod",
      "k8s",
    );

    expect(target).toEqual({ context: "prod-eks", source: "bound" });
  });

  test("bound and ambient context mismatches: refuses loudly, naming env/expected/ambient", async () => {
    execMock.mockResolvedValue({ stdout: "staging-eks\n", stderr: "" });

    const err: unknown = await resolveClusterTarget(
      { k8s: { profiles: { prod: { context: "prod-eks" } } } },
      "prod",
      "k8s",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClusterBindingMismatchError);
    const mismatch = err as InstanceType<typeof ClusterBindingMismatchError>;
    expect(mismatch.environment).toBe("prod");
    expect(mismatch.expectedContext).toBe("prod-eks");
    expect(mismatch.ambientContext).toBe("staging-eks");
    expect(mismatch.message).toContain('environment "prod"');
    expect(mismatch.message).toContain('"prod-eks"');
    expect(mismatch.message).toContain('"staging-eks"');
  });

  test("bound for a different environment than the one requested: treated as unbound for this environment", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const target = await resolveClusterTarget(
      { k8s: { profiles: { staging: { context: "staging-eks" } } } },
      "prod",
      "k8s",
    );

    expect(target).toEqual({ source: "ambient" });
    expect(execMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
