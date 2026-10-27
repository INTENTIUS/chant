/**
 * #4521 on the gcp lexicon: Cloud Asset types mapped to kinds, and a fixture
 * listing typed into nodes through the gcp hooks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { typeListing, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { MASKED } from "@intentius/chant/deep-observation";
import { gcpKindForListedType, gcpListedTypeForKind } from "./listed-types";
import { gcpPlugin } from "./plugin";

const here = import.meta.dirname;
const surface = JSON.parse(readFileSync(join(here, "..", "surface.snapshot.json"), "utf-8")) as {
  entries: Record<string, { kind: string; resourceType: string }>;
};
const KINDS: ReadonlySet<string> = new Set(
  Object.values(surface.entries).filter((e) => e.kind === "resource").map((e) => e.resourceType),
);
const listing = JSON.parse(readFileSync(join(here, "testdata", "indexed", "listing.json"), "utf-8")) as ListingResult;

const gcp: ListingLexicon = {
  name: gcpPlugin.name,
  deepNormalizationHooks: gcpPlugin.deepNormalizationHooks,
  listedTypes: { ...gcpPlugin.listedTypes!, kindFor: (t) => gcpKindForListedType(t, KINDS) },
};

describe("Cloud Asset types to gcp kinds", () => {
  it("every gcp resource kind has an asset type that maps back to it", () => {
    const missing = [...KINDS].filter((k) => {
      const assetType = gcpListedTypeForKind(k);
      return assetType === undefined || gcpKindForListedType(assetType, KINDS) !== k;
    });
    expect(missing).toEqual([]);
  });

  it("maps by rule, and by table where the API's names differ from the lexicon's", () => {
    expect(gcpKindForListedType("storage.googleapis.com/Bucket", KINDS)).toBe("GCP::Storage::Bucket");
    expect(gcpKindForListedType("compute.googleapis.com/Instance", KINDS)).toBe("GCP::Compute::Instance");
    expect(gcpKindForListedType("pubsub.googleapis.com/Topic", KINDS)).toBe("GCP::Pubsub::Topic");
    expect(gcpKindForListedType("sqladmin.googleapis.com/Instance", KINDS)).toBe("GCP::Sql::Instance");
    expect(gcpKindForListedType("cloudresourcemanager.googleapis.com/Project", KINDS)).toBe("GCP::Resourcemanager::Project");
    expect(gcpKindForListedType("cloudkms.googleapis.com/KeyRing", KINDS)).toBe("GCP::Kms::KeyRing");
    expect(gcpKindForListedType("cloudfunctions.googleapis.com/CloudFunction", KINDS)).toBe("GCP::Cloudfunctions::Function");
    expect(gcpKindForListedType("cloudbilling.googleapis.com/ProjectBillingInfo", KINDS)).toBeUndefined();
    expect(gcpKindForListedType("GCP::Storage::Bucket", KINDS)).toBeUndefined();
  });
});

describe("the gcp fixture listing as typed nodes", () => {
  const doc = typeListing(listing, [gcp]);

  it("produces typed nodes, and keeps the unmapped type as an unknown-kind node", () => {
    expect(doc.graph.nodes.map((n) => [n.listedType, n.kind, n.unmappedKind ?? false])).toEqual([
      ["cloudbilling.googleapis.com/ProjectBillingInfo", "cloudbilling.googleapis.com/ProjectBillingInfo", true],
      ["sqladmin.googleapis.com/Instance", "GCP::Sql::Instance", false],
      ["storage.googleapis.com/Bucket", "GCP::Storage::Bucket", false],
    ]);
    expect(doc.notes?.find((n) => n.kind === "unmapped-type")?.listedType).toBe("cloudbilling.googleapis.com/ProjectBillingInfo");
  });

  it("masks secret-named properties and carries labels as tags", () => {
    const sql = doc.graph.nodes.find((n) => n.kind === "GCP::Sql::Instance")!;
    expect((sql.attrs.additionalAttributes as Record<string, unknown>).rootPassword).toBe(MASKED);
    const bucket = doc.graph.nodes.find((n) => n.kind === "GCP::Storage::Bucket")!;
    expect(bucket.tags).toEqual({ "chant-stack": "shop", "managed-by": "chant" });
    expect(bucket.facts?.cloudIds?.map((c) => c.kind)).toEqual(["provider-id", "self-link"]);
  });
});
