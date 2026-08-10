import { describe, expect, it } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import { describeResources, declaredClusterName, type ExecFn } from "./describe-resources";
import { k3dPlugin } from "./plugin";

const LIST_CMD = "k3d cluster list -o json";

function fakeExec(handlers: Record<string, string | Error>): ExecFn {
  return async (command: string) => {
    for (const [prefix, result] of Object.entries(handlers)) {
      if (command.startsWith(prefix)) {
        if (result instanceof Error) throw result;
        return { stdout: result };
      }
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

const RUNNING_CLUSTER = JSON.stringify([
  {
    name: "probe",
    serversCount: 1,
    serversRunning: 1,
    agentsCount: 0,
    agentsRunning: 0,
    nodes: [{ name: "k3d-probe-server-0", role: "server", State: { Running: true } }],
  },
]);

const OWNED_LABELS = JSON.stringify({
  "app.kubernetes.io/managed-by": "chant",
  "chant.intentius.io/stack": "probe",
  "chant.intentius.io/env": "local",
});

function options(names: string[] = ["probe"]) {
  return {
    environment: "local",
    buildOutput: "",
    entityNames: names,
    entities: new Map(names.map((n) => [n, { entityType: "K3d::Cluster", props: {} }])),
  };
}

describe("k3d describeResources", () => {
  it("reports a running, chant-labelled cluster as present and owned", async () => {
    const result = await describeResources(
      options(),
      fakeExec({ [LIST_CMD]: RUNNING_CLUSTER, "docker inspect": OWNED_LABELS }),
    );
    const { resources } = normalizeObservation(result);
    expect(resources.probe.status).toBe("running");
    expect(resources.probe.ownership).toBe("owned");
    expect(resources.probe.physicalId).toBe("probe");
  });

  it("reports a cluster without the marker as foreign", async () => {
    const result = await describeResources(
      options(),
      fakeExec({ [LIST_CMD]: RUNNING_CLUSTER, "docker inspect": JSON.stringify({ "k3d.cluster": "probe" }) }),
    );
    const { resources } = normalizeObservation(result);
    expect(resources.probe.ownership).toBe("foreign");
  });

  it("reports a missing cluster as absent — in neither map", async () => {
    const result = await describeResources(options(), fakeExec({ [LIST_CMD]: "[]", "docker inspect": "{}" }));
    const { resources, unobserved } = normalizeObservation(result);
    expect(resources.probe).toBeUndefined();
    expect(unobserved.probe).toBeUndefined();
  });

  it("reports read-failed for everything when the list command fails — never absence", async () => {
    const result = await describeResources(
      options(["probe", "second"]),
      fakeExec({ [LIST_CMD]: new Error("Cannot connect to the Docker daemon") }),
    );
    const { resources, unobserved } = normalizeObservation(result);
    expect(Object.keys(resources)).toHaveLength(0);
    expect(unobserved.probe.reason).toBe("read-failed");
    expect(unobserved.second.reason).toBe("read-failed");
    expect(unobserved.probe.detail).toContain("Docker");
  });

  it("stays present with ownership unknown when only docker inspect fails", async () => {
    const result = await describeResources(
      options(),
      fakeExec({ [LIST_CMD]: RUNNING_CLUSTER, "docker inspect": new Error("no such container") }),
    );
    const { resources } = normalizeObservation(result);
    expect(resources.probe.status).toBe("running");
    expect(resources.probe.ownership).toBe("unknown");
  });

  it("reports a stopped cluster's status", async () => {
    const stopped = JSON.stringify([
      { name: "probe", serversCount: 1, serversRunning: 0, agentsCount: 0, agentsRunning: 0 },
    ]);
    const result = await describeResources(
      options(),
      fakeExec({ [LIST_CMD]: stopped, "docker inspect": OWNED_LABELS }),
    );
    const { resources } = normalizeObservation(result);
    expect(resources.probe.status).toBe("stopped");
  });

  it("resolves the cluster name from metadata.name over the entity name", () => {
    expect(
      declaredClusterName({ name: "entity", type: "K3d::Cluster", props: { metadata: { name: "real" } } }),
    ).toBe("real");
    expect(declaredClusterName({ name: "entity", type: "K3d::Cluster", props: {} })).toBe("entity");
  });
});

describeObservationConformance({
  lexicon: "k3d",
  ownershipChannel: k3dPlugin.ownershipChannel,
  scenarios: [
    {
      name: "running owned cluster",
      declared: ["probe"],
      owned: true,
      expectPresent: ["probe"],
      run: () =>
        describeResources(options(), fakeExec({ [LIST_CMD]: RUNNING_CLUSTER, "docker inspect": OWNED_LABELS })),
    },
    {
      name: "docker down",
      declared: ["probe"],
      expectUnobserved: ["probe"],
      run: () => describeResources(options(), fakeExec({ [LIST_CMD]: new Error("docker: not running") })),
    },
    {
      name: "cluster absent",
      declared: ["probe"],
      expectAbsent: ["probe"],
      run: () => describeResources(options(), fakeExec({ [LIST_CMD]: "[]" })),
    },
  ],
});
