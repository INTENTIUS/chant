import { describe, it, expect } from "vitest";
import { reconstructEdges, containmentGroups } from "@intentius/chant/graph-refs";
import type { IRNode } from "@intentius/chant/graph-ir";
import { flyReferenceCatalog } from "./reference-catalog";

const n = (id: string, kind: string, physicalId: string, attrs: Record<string, unknown>): IRNode => ({
  id,
  kind,
  lexicon: "fly",
  physicalId,
  attrs,
});

// The shape describeResources() returns: an App boundary, machines (one mounting
// a volume), a volume, an IP — all app-scoped.
const nodes: IRNode[] = [
  n("app", "Fly::Machines::App", "my-app", { app: "my-app" }),
  n("web", "Fly::Machines::Machine", "m1", { app: "my-app", machineName: "web", config: { image: "flyio/hellofly:latest", mounts: [{ volume: "vol_1", path: "/data" }] } }),
  n("worker", "Fly::Machines::Machine", "m2", { app: "my-app", machineName: "worker", config: { image: "flyio/hellofly:latest" } }),
  n("data", "Fly::Machines::Volume", "vol_1", { app: "my-app", volumeName: "data" }),
  n("ip", "Fly::Machines::IPAddress", "1.2.3.4", { app: "my-app", family: "v4" }),
];

describe("flyReferenceCatalog — live graph edges", () => {
  const { edges, containment, dangling } = reconstructEdges(nodes, flyReferenceCatalog);

  it("contains every app-scoped resource in its App (boundary box)", () => {
    for (const child of ["web", "worker", "data", "ip"]) {
      expect(containment).toContainEqual({ child, parent: "app", label: "in app" });
    }
    // containment is never an edge
    expect(edges.some((e) => e.to === "app")).toBe(false);
  });

  it("reconstructs the machine → volume mount edge", () => {
    // mount.volume "vol_1" matches the Volume's physicalId
    expect(edges).toContainEqual({ from: "web", to: "data", kind: "ref", viaAttr: "mounts" });
    // the machine with no mounts has no volume edge
    expect(edges.some((e) => e.from === "worker" && e.to === "data")).toBe(false);
  });

  it("has no dangling references", () => {
    expect(dangling).toEqual([]);
  });

  it("containment groups nest App → resources (for #779 boundaries)", () => {
    const g = containmentGroups(containment);
    expect(g.app).toEqual(expect.arrayContaining(["web", "worker", "data", "ip"]));
  });
});
