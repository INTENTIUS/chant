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

describe("resolveClusterTarget (chant #1100, #1488)", () => {
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

  test("bound: returns the bound context without ever probing the ambient one (#1488)", async () => {
    const target = await resolveClusterTarget(
      { k8s: { profiles: { prod: { context: "prod-eks" } } } },
      "prod",
      "k8s",
    );

    expect(target).toEqual({ context: "prod-eks", source: "bound" });
    expect(execMock).not.toHaveBeenCalled();
  });

  test("bound while a different context is ambient: the binding wins, no refusal (#1488)", async () => {
    // Ambient says staging-eks; the declared binding must be used regardless.
    // Before #1488 this threw ClusterBindingMismatchError, which turned a
    // healthy estate grey the moment any other project switched the context.
    execMock.mockResolvedValue({ stdout: "staging-eks\n", stderr: "" });

    const target = await resolveClusterTarget(
      { k8s: { profiles: { prod: { context: "prod-eks" } } } },
      "prod",
      "k8s",
    );

    expect(target).toEqual({ context: "prod-eks", source: "bound" });
  });

  test("ClusterBindingMismatchError still constructs and names all three parts (catchers rely on it)", () => {
    const err = new ClusterBindingMismatchError("prod", "prod-eks", "staging-eks");
    expect(err.environment).toBe("prod");
    expect(err.expectedContext).toBe("prod-eks");
    expect(err.ambientContext).toBe("staging-eks");
    expect(err.message).toContain('environment "prod"');
    expect(err.message).toContain('"prod-eks"');
    expect(err.message).toContain('"staging-eks"');
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
