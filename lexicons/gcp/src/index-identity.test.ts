/**
 * #4538 on the gcp lexicon: the index match and `chant search --index`'s join
 * over a listing recorded from floci-gcp (./testdata/indexed/identity.listing.json,
 * core's lister against project `ladybug-4538` seeded with a network, a
 * subnetwork, a disk, a VM, a bucket, a topic, a subscription and a service
 * account).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { GraphIR, IRNode } from "@intentius/chant/graph-ir";
import { matchDeclaredToIndex } from "@intentius/chant/lifecycle/identity-match";
import { joinDeclaredToIndex } from "@intentius/chant/lifecycle/index-join";
import { deriveEdges } from "@intentius/chant/lifecycle/derive-edges";
import { typeListing, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { gcpDeclaredIdentity, gcpIndexIdentity, gcpNodeIdentities, gcpNodeKey, relativeResourceName } from "./index-identity";
import { gcpPlugin } from "./plugin";

const listing = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "indexed", "identity.listing.json"), "utf-8")) as ListingResult;
const doc = typeListing(listing, [gcpPlugin]);
const P = "//compute.googleapis.com/projects/ladybug-4538";

const node = (name: string, kind: string, attrs: Record<string, unknown>): IRNode => ({ id: `app::${name}`, kind, lexicon: "gcp", attrs });
const meta = (name: string) => ({ metadata: { name } });

describe("gcpDeclaredIdentity", () => {
  test("the name is resourceID, else metadata.name, under the asset type", () => {
    expect(gcpDeclaredIdentity("GCP::Compute::Network", meta("net"))).toEqual({
      kind: "identifier",
      listedType: "compute.googleapis.com/Network",
      identifier: "net",
      global: false,
      location: "*",
    });
    expect(gcpDeclaredIdentity("GCP::Compute::Instance", { ...meta("k8s-name"), resourceID: "vm", zone: "us-central1-a" })).toMatchObject({
      identifier: "vm",
      location: "us-central1-a",
    });
    // A manifest keeps the fields under spec.
    expect(gcpDeclaredIdentity("GCP::Compute::Subnetwork", { ...meta("sub"), spec: { region: "us-central1" } })).toMatchObject({ location: "us-central1" });
  });

  test("a literal location is lowercased, as Cloud Asset spells it", () => {
    expect(gcpDeclaredIdentity("GCP::Storage::Bucket", { ...meta("b"), location: "US" })).toMatchObject({ location: "us" });
  });

  test("a location spelled with a reference is looked for everywhere", () => {
    expect(gcpDeclaredIdentity("GCP::Storage::Bucket", { ...meta("b"), location: { ref: "region" } })).toMatchObject({ location: "*" });
  });

  test("a name the declaration does not spell is no-binding", () => {
    expect(gcpDeclaredIdentity("GCP::Pubsub::Topic", {})).toMatchObject({ kind: "unmatchable", reason: "no-binding" });
    expect(gcpDeclaredIdentity("GCP::Pubsub::Topic", { metadata: { name: { ref: "x" } } })).toMatchObject({ kind: "unmatchable", reason: "no-binding" });
  });

  test("a kind Cloud Asset names by a server-assigned number is no-binding", () => {
    expect(gcpDeclaredIdentity("GCP::Iam::ServiceAccount", meta("sa"))).toMatchObject({
      kind: "unmatchable",
      reason: "no-binding",
      detail: expect.stringContaining("unique id"),
    });
  });

  test("a kind with no asset type is unsupported-kind", () => {
    expect(gcpDeclaredIdentity("NotGcp", meta("x"))).toMatchObject({ kind: "unmatchable", reason: "unsupported-kind" });
  });
});

describe("node keys and identities", () => {
  test("the key is the last segment of the resource name, whatever spells the rest", () => {
    expect(gcpNodeKey({ nativeId: `${P}/zones/us-central1-a/instances/vm` })).toBe("vm");
    expect(gcpNodeKey({ nativeId: "//storage.googleapis.com/projects/_/buckets/b" })).toBe("b");
    expect(gcpNodeKey({ nativeId: "//storage.googleapis.com/b" })).toBe("b");
    expect(gcpNodeKey({})).toBeUndefined();
  });

  test("a Compute asset answers to its asset name, relative name and selfLink", () => {
    const net = doc.graph.nodes.find((n) => n.nativeId === `${P}/global/networks/ladybug-net`)!;
    expect(gcpNodeIdentities(net).map((v) => v.value)).toEqual([
      `${P}/global/networks/ladybug-net`,
      "projects/ladybug-4538/global/networks/ladybug-net",
      "https://www.googleapis.com/compute/v1/projects/ladybug-4538/global/networks/ladybug-net",
    ]);
    expect(relativeResourceName("not-an-asset-name")).toBeUndefined();
  });

  test("a property naming a network by relative name or selfLink draws an identity edge", () => {
    const vmId = doc.graph.nodes.find((n) => n.nativeId === `${P}/zones/us-central1-a/instances/ladybug-vm`)!.id;
    const subnetId = doc.graph.nodes.find((n) => n.nativeId === `${P}/regions/us-central1/subnetworks/ladybug-subnet`)!.id;
    const netId = doc.graph.nodes.find((n) => n.nativeId === `${P}/global/networks/ladybug-net`)!.id;
    const withRefs = {
      ...doc,
      graph: {
        ...doc.graph,
        nodes: doc.graph.nodes.map((n) =>
          n.id === vmId
            ? { ...n, attrs: { ...n.attrs, networkInterfaces: [{ network: "https://www.googleapis.com/compute/v1/projects/ladybug-4538/global/networks/ladybug-net" }] } }
            : n.id === subnetId
              ? { ...n, attrs: { ...n.attrs, network: "projects/ladybug-4538/global/networks/ladybug-net" } }
              : n,
        ),
      },
    };
    const edges = deriveEdges(withRefs, [gcpPlugin]).graph.edges.filter((e) => e.rule?.startsWith("identity-match:"));
    expect(edges.map((e) => [e.from, e.to])).toEqual(
      expect.arrayContaining([
        [vmId, netId],
        [subnetId, netId],
      ]),
    );
  });
});

describe("search --index's join on the floci-gcp listing", () => {
  const declared: GraphIR = {
    version: 1,
    nodes: [
      node("net", "GCP::Compute::Network", meta("ladybug-net")),
      node("subnet", "GCP::Compute::Subnetwork", { ...meta("ladybug-subnet"), region: "us-central1", ipCidrRange: "10.10.0.0/24" }),
      node("vm", "GCP::Compute::Instance", { ...meta("web"), resourceID: "ladybug-vm", zone: "us-central1-a" }),
      node("disk", "GCP::Compute::Disk", { ...meta("ladybug-disk"), location: "us-east1-b" }),
      node("data", "GCP::Storage::Bucket", { ...meta("ladybug-4538-data"), location: "US" }),
      node("archive", "GCP::Storage::Bucket", { ...meta("ladybug-4538-archive"), location: "US" }),
      node("topic", "GCP::Pubsub::Topic", meta("ladybug-topic")),
      node("sub", "GCP::Pubsub::Subscription", { ...meta("ladybug-sub"), topicRef: { name: "ladybug-topic" } }),
      node("sa", "GCP::Iam::ServiceAccount", meta("ladybug-sa")),
    ],
    edges: [],
    groups: { byLexicon: {} },
  };
  const { ir, joins } = joinDeclaredToIndex(declared, doc, [gcpPlugin]);
  const row = (name: string) => ir.nodes.find((n) => n.id === `app::${name}`)!;

  test("every seeded resource the declaration names is bound, global, regional, zonal and multi-region alike", () => {
    expect(joins["app::net"]).toMatchObject({ verdict: "bound", nativeId: `${P}/global/networks/ladybug-net`, location: "global" });
    expect(joins["app::subnet"]).toMatchObject({ verdict: "bound", nativeId: `${P}/regions/us-central1/subnetworks/ladybug-subnet`, location: "us-central1" });
    expect(joins["app::vm"]).toMatchObject({ verdict: "bound", nativeId: `${P}/zones/us-central1-a/instances/ladybug-vm`, location: "us-central1-a" });
    expect(joins["app::data"]).toMatchObject({ verdict: "bound", nativeId: "//storage.googleapis.com/ladybug-4538-data", location: "us" });
    expect(joins["app::topic"]).toMatchObject({ verdict: "bound", nativeId: "//pubsub.googleapis.com/projects/ladybug-4538/topics/ladybug-topic" });
    expect(joins["app::sub"]).toMatchObject({ verdict: "bound", nativeId: "//pubsub.googleapis.com/projects/ladybug-4538/subscriptions/ladybug-sub" });
    expect(row("vm").physicalId).toBe(`${P}/zones/us-central1-a/instances/ladybug-vm`);
    expect(row("data").facts?.cloudIds).toContainEqual({ kind: "provider-id", value: "//storage.googleapis.com/ladybug-4538-data" });
  });

  test("a name the index does not hold, or holds at another location, is absent", () => {
    expect(joins["app::archive"]).toMatchObject({ verdict: "absent", identifier: "ladybug-4538-archive", location: "us" });
    expect(joins["app::disk"]).toMatchObject({ verdict: "absent", identifier: "ladybug-disk", location: "us-east1-b" });
  });

  test("the service account is no-binding, though it is indexed", () => {
    expect(joins["app::sa"]).toMatchObject({ verdict: "no-binding" });
    expect(row("sa").physicalId).toBeUndefined();
  });

  test("two nodes of one name at different locations are refused when the declaration names no location", () => {
    const twin = doc.graph.nodes.find((n) => n.nativeId === `${P}/regions/us-central1/subnetworks/ladybug-subnet`)!;
    const twoRegions = {
      ...doc,
      graph: {
        ...doc.graph,
        nodes: [...doc.graph.nodes, { ...twin, id: `${twin.id}-east`, location: "us-east1", nativeId: `${P}/regions/us-east1/subnetworks/ladybug-subnet` }],
      },
    };
    const { matches } = matchDeclaredToIndex(
      [
        { name: "any", entityType: "GCP::Compute::Subnetwork", props: meta("ladybug-subnet") },
        { name: "east", entityType: "GCP::Compute::Subnetwork", props: { ...meta("ladybug-subnet"), region: "us-east1" } },
      ],
      [twoRegions],
      gcpIndexIdentity,
    );
    expect(matches.any).toMatchObject({ verdict: "refused", candidates: [twin.id, `${twin.id}-east`].sort() });
    expect(matches.east).toMatchObject({ verdict: "bound", location: "us-east1" });
  });
});
