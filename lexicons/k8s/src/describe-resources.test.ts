import { describe, test, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    Promise.resolve(execMock(cmd)).then(
      (out) => cb(null, out),
      (err) => cb(err as Error, { stdout: "", stderr: "" }),
    );
  } };
});

const loadChantConfigMock = vi.fn();
vi.mock("@intentius/chant/config", () => ({
  loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args),
}));

const { describeResources } = await import("./describe-resources");

function makeEntities(records: Array<{ name: string; entityType: string; props: Record<string, unknown> }>) {
  return new Map(records.map((r) => [r.name, { entityType: r.entityType, props: r.props }]));
}

describe("k8s describeResources", () => {
  beforeEach(() => {
    execMock.mockReset();
    loadChantConfigMock.mockReset();
    // No binding declared by default — matches every test below except the
    // dedicated cluster-binding tests, which override this per case.
    loadChantConfigMock.mockResolvedValue({ config: {} });
  });

  test("queries kubectl for each declared K8s entity and maps response to ResourceMetadata", async () => {
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("deployment.apps web")) {
        return {
          stdout: JSON.stringify({
            metadata: { name: "web", namespace: "prod", uid: "uid-1", creationTimestamp: "2026-05-01T00:00:00Z", labels: { app: "web" } },
            status: { readyReplicas: 3, replicas: 3 },
          }),
          stderr: "",
        };
      }
      if (cmd.includes("service web-svc")) {
        return {
          stdout: JSON.stringify({
            metadata: { name: "web-svc", namespace: "prod", uid: "uid-2", creationTimestamp: "2026-05-01T00:00:00Z" },
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const entities = makeEntities([
      { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
      { name: "webSvc", entityType: "K8s::Core::Service", props: { metadata: { name: "web-svc", namespace: "prod" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["web", "webSvc"], entities });

    expect(result["web"]).toMatchObject({
      type: "K8s::Apps::Deployment",
      physicalId: "uid-1",
      status: "READY",
      attributes: expect.objectContaining({ namespace: "prod", labels: { app: "web" } }),
    });
    expect(result["webSvc"]).toMatchObject({
      type: "K8s::Core::Service",
      physicalId: "uid-2",
      status: "PRESENT",
    });
  });

  test("kubectl-not-found leaves entity out of the result (so state diff reports as missing)", async () => {
    execMock.mockImplementation(() => { throw new Error('Error from server (NotFound): deployments.apps "missing" not found'); });

    const entities = makeEntities([
      { name: "missing", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "missing", namespace: "prod" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["missing"], entities });

    expect(result).toEqual({});
  });

  test("entity types without kubectl mapping are warn-skipped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entities = makeEntities([
      { name: "exotic", entityType: "K8s::Custom::CRD::SomeOperator", props: { metadata: { name: "x" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["exotic"], entities });

    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("kubectl mapping"));
    const mappingWarning = warnSpy.mock.calls.find((c) => String(c[0]).includes("kubectl mapping"));
    expect(mappingWarning?.[0]).toContain("K8s::Custom::CRD::SomeOperator");
    warnSpy.mockRestore();
  });

  test("Deployment with replicas != readyReplicas reports PROGRESSING", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        metadata: { name: "web", namespace: "prod", uid: "uid", creationTimestamp: "t" },
        status: { readyReplicas: 1, replicas: 3 },
      }),
      stderr: "",
    });

    const entities = makeEntities([
      { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["web"], entities });

    expect(result["web"].status).toBe("PROGRESSING(1/3)");
  });

  test("Pod uses status.phase as the status", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        metadata: { name: "p", namespace: "prod", uid: "uid", creationTimestamp: "t" },
        status: { phase: "Running" },
      }),
      stderr: "",
    });

    const entities = makeEntities([
      { name: "p", entityType: "K8s::Core::Pod", props: { metadata: { name: "p", namespace: "prod" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["p"], entities });

    expect(result["p"].status).toBe("Running");
  });

  test("namespace-less resource omits the -n flag", async () => {
    let receivedCmd = "";
    execMock.mockImplementation((cmd: string) => {
      receivedCmd = cmd;
      return {
        stdout: JSON.stringify({
          metadata: { name: "mynamespace", uid: "uid", creationTimestamp: "t" },
          status: { phase: "Active" },
        }),
        stderr: "",
      };
    });

    const entities = makeEntities([
      { name: "ns", entityType: "K8s::Core::Namespace", props: { metadata: { name: "mynamespace" } } },
    ]);

    await describeResources({ environment: "prod", buildOutput: "", entityNames: ["ns"], entities });

    expect(receivedCmd).not.toContain("-n");
    expect(receivedCmd).toContain("namespace mynamespace");
  });

  test("entity without metadata.name is silently skipped", async () => {
    const entities = makeEntities([
      { name: "broken", entityType: "K8s::Apps::Deployment", props: {} },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["broken"], entities });

    expect(result).toEqual({});
    expect(execMock).not.toHaveBeenCalled();
  });

  // chant #1100 — environment→cluster binding: bound-and-matching,
  // bound-and-mismatched (loud refusal), and unbound (unchanged) paths.
  describe("cluster binding (chant #1100)", () => {
    function deploymentEntities() {
      return makeEntities([
        { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
      ]);
    }

    const deploymentStdout = JSON.stringify({
      metadata: { name: "web", namespace: "prod", uid: "uid-1", creationTimestamp: "2026-05-01T00:00:00Z" },
      status: { readyReplicas: 1, replicas: 1 },
    });

    test("bound and ambient context matches: observes explicitly via --context", async () => {
      loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-eks" } } } } });
      let receivedCmd = "";
      execMock.mockImplementation((cmd: string) => {
        if (cmd.includes("current-context")) return { stdout: "prod-eks\n", stderr: "" };
        receivedCmd = cmd;
        return { stdout: deploymentStdout, stderr: "" };
      });

      const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["web"], entities: deploymentEntities() });

      expect(receivedCmd).toContain("--context prod-eks");
      expect(result["web"]).toMatchObject({ type: "K8s::Apps::Deployment", physicalId: "uid-1", status: "READY" });
    });

    test("bound and ambient context mismatches: refuses loudly instead of observing the wrong cluster", async () => {
      loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-eks" } } } } });
      execMock.mockImplementation((cmd: string) => {
        if (cmd.includes("current-context")) return { stdout: "staging-eks\n", stderr: "" };
        throw new Error(`unexpected cmd (should have refused before any kubectl get): ${cmd}`);
      });

      await expect(
        describeResources({ environment: "prod", buildOutput: "", entityNames: ["web"], entities: deploymentEntities() }),
      ).rejects.toThrow(/environment "prod".*"prod-eks".*"staging-eks"/s);

      // Only the ambient-context probe ran — no per-entity kubectl get was attempted.
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    test("unbound: ambient context is used unchanged, but the fallback is visible (not silent)", async () => {
      loadChantConfigMock.mockResolvedValue({ config: {} });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      let receivedCmd = "";
      execMock.mockImplementation((cmd: string) => {
        receivedCmd = cmd;
        return { stdout: deploymentStdout, stderr: "" };
      });

      const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["web"], entities: deploymentEntities() });

      // Unchanged: no ambient-context probe, no --context flag, same result shape as today.
      expect(receivedCmd).not.toContain("--context");
      expect(receivedCmd).not.toContain("current-context");
      expect(result["web"]).toMatchObject({ type: "K8s::Apps::Deployment", physicalId: "uid-1", status: "READY" });

      // Visible, not silent: a warning names the environment and the missing binding.
      const bindingWarning = warnSpy.mock.calls.find((c) => String(c[0]).includes("no cluster binding"));
      expect(bindingWarning?.[0]).toContain('environment "prod"');
      expect(bindingWarning?.[0]).toContain("k8s.profiles.prod.context");
      warnSpy.mockRestore();
    });
  });
});
