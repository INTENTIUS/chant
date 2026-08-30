import { describe, expect, it } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import {
  describeResources,
  declaredNodeName,
  type ExecFn,
} from "./describe-resources";
import { k3sPlugin } from "./plugin";
import { SERVER_TYPE, AGENT_TYPE, REGISTRIES_TYPE } from "./serializer";
import { K3S_VERSION } from "./spec/fetch";

const VERSION_CMD = "kubectl version -o json";

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

const VERSION_OK = JSON.stringify({ serverVersion: { gitVersion: K3S_VERSION } });
const VERSION_OLD = JSON.stringify({ serverVersion: { gitVersion: "v1.30.0+k3s1" } });

function readyNode(labels: Record<string, string> = {}) {
  return JSON.stringify({
    metadata: { uid: "node-uid-1", labels, creationTimestamp: "2026-01-01T00:00:00Z" },
    status: {
      nodeInfo: { kubeletVersion: K3S_VERSION },
      conditions: [{ type: "Ready", status: "True" }],
    },
  });
}

const OWNED_LABELS = {
  "app.kubernetes.io/managed-by": "chant",
  "chant.intentius.io/stack": "probe",
  "chant.intentius.io/env": "local",
};

function options(
  entities: Array<[string, string, Record<string, unknown>]> = [["cp", SERVER_TYPE, { "node-name": "cp-1" }]],
  extra: { owned?: boolean } = {},
) {
  return {
    environment: "probe-env-unbound",
    buildOutput: "",
    entityNames: entities.map(([name]) => name),
    entities: new Map(entities.map(([name, entityType, props]) => [name, { entityType, props }])),
    ...extra,
  };
}

describe("k3s describeResources", () => {
  it("reports a Ready, chant-labelled server node as present and owned", async () => {
    const result = await describeResources(
      options(),
      fakeExec({ [VERSION_CMD]: VERSION_OK, "kubectl get node": readyNode(OWNED_LABELS) }),
    );
    const { resources } = normalizeObservation(result);
    expect(resources.cp.status).toBe("Ready");
    expect(resources.cp.ownership).toBe("owned");
    expect(resources.cp.physicalId).toBe("node-uid-1");
    expect((resources.cp.attributes as Record<string, unknown>).versionMatchesPin).toBe(true);
  });

  it("reports a node without the marker as foreign", async () => {
    const result = await describeResources(
      options(),
      fakeExec({ [VERSION_CMD]: VERSION_OK, "kubectl get node": readyNode() }),
    );
    const { resources } = normalizeObservation(result);
    expect(resources.cp.ownership).toBe("foreign");
  });

  it("reports the live k3s build against the pin — a mismatch is informational, not a failure", async () => {
    const result = await describeResources(
      options(),
      fakeExec({ [VERSION_CMD]: VERSION_OLD, "kubectl get node": readyNode(OWNED_LABELS) }),
    );
    const { resources } = normalizeObservation(result);
    expect((resources.cp.attributes as Record<string, unknown>).k3sVersion).toBe("v1.30.0+k3s1");
    expect((resources.cp.attributes as Record<string, unknown>).versionMatchesPin).toBe(false);
  });

  it("reports a NotReady node's reason as the status", async () => {
    const notReady = JSON.stringify({
      metadata: { uid: "node-uid-2", labels: OWNED_LABELS },
      status: { conditions: [{ type: "Ready", status: "False", reason: "KubeletNotReady" }] },
    });
    const result = await describeResources(
      options(),
      fakeExec({ [VERSION_CMD]: VERSION_OK, "kubectl get node": notReady }),
    );
    const { resources } = normalizeObservation(result);
    expect(resources.cp.status).toBe("KubeletNotReady");
  });

  it("reports a missing node as absent — in neither map", async () => {
    const result = await describeResources(
      options(),
      fakeExec({
        [VERSION_CMD]: VERSION_OK,
        "kubectl get node": new Error(`Error from server (NotFound): nodes "cp-1" not found`),
      }),
    );
    const { resources, unobserved } = normalizeObservation(result);
    expect(resources.cp).toBeUndefined();
    expect(unobserved.cp).toBeUndefined();
  });

  it("reports not-observed, naming the context, when the apiserver is unreachable — never absence", async () => {
    const result = await describeResources(
      options([
        ["cp", SERVER_TYPE, { "node-name": "cp-1" }],
        ["worker", AGENT_TYPE, { "node-name": "agent-1" }],
      ]),
      fakeExec({ [VERSION_CMD]: new Error("some unexpected apiserver fault") }),
    );
    const { resources, unobserved } = normalizeObservation(result);
    expect(Object.keys(resources)).toHaveLength(0);
    expect(unobserved.cp.reason).toBe("read-failed");
    expect(unobserved.worker.reason).toBe("read-failed");
    expect(unobserved.cp.detail).toContain("kubectl context");
    expect(unobserved.cp.detail).toContain("apiserver fault");
  });

  it("reports read-failed for an entity with no declared node-name — never a guessed address", async () => {
    const result = await describeResources(
      options([["cp", SERVER_TYPE, {}]]),
      fakeExec({ [VERSION_CMD]: VERSION_OK }),
    );
    const { resources, unobserved } = normalizeObservation(result);
    expect(resources.cp).toBeUndefined();
    expect(unobserved.cp.reason).toBe("read-failed");
    expect(unobserved.cp.detail).toContain("node-name");
  });

  it("reports K3s::Registries as unsupported-kind — no live object exists to read", async () => {
    const result = await describeResources(
      options([["reg", REGISTRIES_TYPE, {}]]),
      fakeExec({ [VERSION_CMD]: VERSION_OK }),
    );
    const { unobserved } = normalizeObservation(result);
    expect(unobserved.reg.reason).toBe("unsupported-kind");
  });

  it("filters a foreign node out under --owned, without reporting it absent", async () => {
    const result = await describeResources(
      options(undefined, { owned: true }),
      fakeExec({ [VERSION_CMD]: VERSION_OK, "kubectl get node": readyNode() }),
    );
    const { resources, unobserved } = normalizeObservation(result);
    expect(resources.cp).toBeUndefined();
    expect(unobserved.cp.reason).toBe("filtered");
  });

  it("keeps an owned node present under --owned", async () => {
    const result = await describeResources(
      options(undefined, { owned: true }),
      fakeExec({ [VERSION_CMD]: VERSION_OK, "kubectl get node": readyNode(OWNED_LABELS) }),
    );
    const { resources } = normalizeObservation(result);
    expect(resources.cp.ownership).toBe("owned");
  });

  it("resolves node identity from the declared node-name only — never a guess", () => {
    expect(declaredNodeName({ name: "entity", type: SERVER_TYPE, props: { "node-name": "real" } })).toBe(
      "real",
    );
    expect(declaredNodeName({ name: "entity", type: SERVER_TYPE, props: {} })).toBeUndefined();
  });
});

describeObservationConformance({
  lexicon: "k3s",
  ownershipChannel: k3sPlugin.ownershipChannel,
  scenarios: [
    {
      name: "Ready owned server node",
      declared: ["cp"],
      owned: true,
      expectPresent: ["cp"],
      run: () =>
        describeResources(options(), fakeExec({ [VERSION_CMD]: VERSION_OK, "kubectl get node": readyNode(OWNED_LABELS) })),
    },
    {
      name: "apiserver unreachable",
      declared: ["cp"],
      expectUnobserved: ["cp"],
      run: () => describeResources(options(), fakeExec({ [VERSION_CMD]: new Error("connection refused") })),
    },
    {
      name: "node absent",
      declared: ["cp"],
      expectAbsent: ["cp"],
      run: () =>
        describeResources(
          options(),
          fakeExec({ [VERSION_CMD]: VERSION_OK, "kubectl get node": new Error("NotFound") }),
        ),
    },
  ],
});
