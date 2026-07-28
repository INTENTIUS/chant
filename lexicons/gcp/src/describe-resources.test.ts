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

describe("gcp describeResources (Config Connector)", () => {
  beforeEach(() => {
    execMock.mockReset();
    loadChantConfigMock.mockReset();
    // No binding declared by default — matches every test below except the
    // dedicated cluster-binding tests, which override this per case.
    loadChantConfigMock.mockResolvedValue({ config: {} });
  });

  test("queries kubectl with the derived CC GVK and maps the response", async () => {
    let receivedCmd = "";
    execMock.mockImplementation((cmd: string) => {
      receivedCmd = cmd;
      return {
        stdout: JSON.stringify({
          metadata: { name: "data-bucket", namespace: "config-control", uid: "uid-1", creationTimestamp: "2026-05-01T00:00:00Z" },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        }),
        stderr: "",
      };
    });

    const entities = makeEntities([
      { name: "dataBucket", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "data-bucket", namespace: "config-control" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["dataBucket"], entities });

    // Resource name follows: <lowerKind>.<service>.cnrm.cloud.google.com
    expect(receivedCmd).toContain("storagebucket.storage.cnrm.cloud.google.com");
    expect(receivedCmd).toContain("data-bucket");
    expect(receivedCmd).toContain("-n config-control");

    expect(result["dataBucket"]).toMatchObject({
      type: "GCP::Storage::Bucket",
      physicalId: "uid-1",
      status: "READY",
    });
  });

  test("Compute resource derives correct GVK with service prefix", async () => {
    let receivedCmd = "";
    execMock.mockImplementation((cmd: string) => {
      receivedCmd = cmd;
      return {
        stdout: JSON.stringify({
          metadata: { name: "subnet-1", uid: "uid", creationTimestamp: "t" },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        }),
        stderr: "",
      };
    });

    const entities = makeEntities([
      { name: "sub", entityType: "GCP::Compute::Subnetwork", props: { metadata: { name: "subnet-1" } } },
    ]);

    await describeResources({ environment: "prod", buildOutput: "", entityNames: ["sub"], entities });

    expect(receivedCmd).toContain("computesubnetwork.compute.cnrm.cloud.google.com");
  });

  test("Ready=False maps to the condition's reason", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        metadata: { name: "x", uid: "uid", creationTimestamp: "t" },
        status: { conditions: [{ type: "Ready", status: "False", reason: "DependencyNotFound", message: "..." }] },
      }),
      stderr: "",
    });

    const entities = makeEntities([
      { name: "x", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "x" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["x"], entities });

    expect(result["x"].status).toBe("DependencyNotFound");
  });

  test("missing Ready condition falls back to PRESENT", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        metadata: { name: "x", uid: "uid", creationTimestamp: "t" },
        status: {},
      }),
      stderr: "",
    });

    const entities = makeEntities([
      { name: "x", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "x" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["x"], entities });

    expect(result["x"].status).toBe("PRESENT");
  });

  test("kubectl-not-found leaves entity out of result", async () => {
    execMock.mockImplementation(() => { throw new Error('Error from server (NotFound): storagebucket "x" not found'); });

    const entities = makeEntities([
      { name: "x", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "x" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["x"], entities });

    expect(result).toEqual({});
  });

  test("non-GCP entity types are skipped", async () => {
    const entities = makeEntities([
      { name: "x", entityType: "AWS::S3::Bucket", props: { metadata: { name: "x" } } },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["x"], entities });

    expect(result).toEqual({});
    expect(execMock).not.toHaveBeenCalled();
  });

  test("entity without metadata.name is silently skipped", async () => {
    const entities = makeEntities([
      { name: "broken", entityType: "GCP::Storage::Bucket", props: {} },
    ]);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["broken"], entities });

    expect(result).toEqual({});
    expect(execMock).not.toHaveBeenCalled();
  });

  // chant #1100 — GCP-via-CNRM resolves the same environment→cluster binding
  // as the K8s lexicon (bound-and-matching, bound-and-mismatched loud
  // refusal, unbound unchanged), since it observes through the same kubectl
  // path against the same cluster.
  describe("cluster binding (chant #1100)", () => {
    function bucketEntities() {
      return makeEntities([
        { name: "dataBucket", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "data-bucket" } } },
      ]);
    }

    const bucketStdout = JSON.stringify({
      metadata: { name: "data-bucket", uid: "uid-1", creationTimestamp: "2026-05-01T00:00:00Z" },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });

    test("bound and ambient context matches: observes explicitly via --context", async () => {
      loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-cnrm" } } } } });
      let receivedCmd = "";
      execMock.mockImplementation((cmd: string) => {
        if (cmd.includes("current-context")) return { stdout: "prod-cnrm\n", stderr: "" };
        receivedCmd = cmd;
        return { stdout: bucketStdout, stderr: "" };
      });

      const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["dataBucket"], entities: bucketEntities() });

      expect(receivedCmd).toContain("--context prod-cnrm");
      expect(result["dataBucket"]).toMatchObject({ type: "GCP::Storage::Bucket", physicalId: "uid-1", status: "READY" });
    });

    test("bound and ambient context mismatches: refuses loudly instead of observing the wrong cluster", async () => {
      loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-cnrm" } } } } });
      execMock.mockImplementation((cmd: string) => {
        if (cmd.includes("current-context")) return { stdout: "staging-cnrm\n", stderr: "" };
        throw new Error(`unexpected cmd (should have refused before any kubectl get): ${cmd}`);
      });

      await expect(
        describeResources({ environment: "prod", buildOutput: "", entityNames: ["dataBucket"], entities: bucketEntities() }),
      ).rejects.toThrow(/environment "prod".*"prod-cnrm".*"staging-cnrm"/s);

      expect(execMock).toHaveBeenCalledTimes(1);
    });

    test("unbound: ambient context is used unchanged, but the fallback is visible (not silent)", async () => {
      loadChantConfigMock.mockResolvedValue({ config: {} });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      let receivedCmd = "";
      execMock.mockImplementation((cmd: string) => {
        receivedCmd = cmd;
        return { stdout: bucketStdout, stderr: "" };
      });

      const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: ["dataBucket"], entities: bucketEntities() });

      expect(receivedCmd).not.toContain("--context");
      expect(receivedCmd).not.toContain("current-context");
      expect(result["dataBucket"]).toMatchObject({ type: "GCP::Storage::Bucket", physicalId: "uid-1", status: "READY" });

      const bindingWarning = warnSpy.mock.calls.find((c) => String(c[0]).includes("no cluster binding"));
      expect(bindingWarning?.[0]).toContain('environment "prod"');
      expect(bindingWarning?.[0]).toContain("k8s.profiles.prod.context");
      warnSpy.mockRestore();
    });
  });
});
