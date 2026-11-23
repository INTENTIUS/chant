import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { reservedNamesFromSnapshot } from "@intentius/chant/codegen/naming";
import { NamingStrategy, propertyTypeName, publishedNames } from "./naming";
import type { GcpParseResult } from "../spec/parse";

function makeResult(typeName: string): GcpParseResult {
  return {
    resource: {
      typeName,
      properties: [],
      attributes: [],
      deprecatedProperties: [],
    },
    propertyTypes: [],
    enums: [],
    gvk: { group: "", version: "v1beta1", kind: typeName.split("::").pop()! },
  };
}

describe("NamingStrategy", () => {
  test("resolves priority names", () => {
    const results = [
      makeResult("GCP::Compute::Instance"),
      makeResult("GCP::Storage::Bucket"),
      makeResult("GCP::Container::Cluster"),
    ];
    const naming = new NamingStrategy(results);

    expect(naming.resolve("GCP::Compute::Instance")).toBe("ComputeInstance");
    expect(naming.resolve("GCP::Storage::Bucket")).toBe("StorageBucket");
    expect(naming.resolve("GCP::Container::Cluster")).toBe("GKECluster");
  });

  test("provides aliases", () => {
    const results = [makeResult("GCP::Container::Cluster")];
    const naming = new NamingStrategy(results);

    const aliases = naming.aliases("GCP::Container::Cluster");
    expect(aliases).toContain("GKE");
  });

  test("resolves non-priority types by short name", () => {
    const results = [makeResult("GCP::Accesscontextmanager::AccessLevel")];
    const naming = new NamingStrategy(results);

    const name = naming.resolve("GCP::Accesscontextmanager::AccessLevel");
    expect(name).toBeDefined();
    expect(name!.length).toBeGreaterThan(0);
  });
});

describe("published names stay with the type that published them (#5549)", () => {
  const resolveAll = (types: string[], reserved?: Record<string, string>) => {
    const naming = new NamingStrategy(types.map(makeResult), reserved);
    return Object.fromEntries(types.map((t) => [t, naming.resolve(t)]));
  };

  test("with the committed snapshot, a colliding newcomer is prefixed and the published type keeps its name", () => {
    const reserved = publishedNames();
    expect(reserved["GCP::Pubsub::Schema"]).toBe("Schema");
    expect(reserved["GCP::Containeranalysis::Note"]).toBe("Note");

    const types = [
      "GCP::Discoveryengine::Schema",
      "GCP::Pubsub::Schema",
      "GCP::Containeranalysis::Note",
      "GCP::Grafeas::Note",
      "GCP::Compute::Instance",
    ];
    const names = resolveAll(types, reserved);
    expect(names).toEqual({
      "GCP::Discoveryengine::Schema": "DiscoveryengineSchema",
      "GCP::Pubsub::Schema": "Schema",
      "GCP::Containeranalysis::Note": "Note",
      "GCP::Grafeas::Note": "GrafeasNote",
      "GCP::Compute::Instance": "ComputeInstance",
    });
    expect(resolveAll([...types].reverse(), reserved)).toEqual(names);
  });

  test("with no snapshot, names follow the rule: a shared short name prefixes every holder", () => {
    const reserved = publishedNames(join(import.meta.dirname, "no-such-dir", "surface.snapshot.json"));
    expect(reserved).toEqual({});
    expect(resolveAll(["GCP::Pubsub::Schema", "GCP::Discoveryengine::Schema", "GCP::Compute::Instance"], reserved)).toEqual({
      "GCP::Pubsub::Schema": "PubSubSchema",
      "GCP::Discoveryengine::Schema": "DiscoveryengineSchema",
      "GCP::Compute::Instance": "ComputeInstance",
    });
    expect(resolveAll(["GCP::Pubsub::Schema", "GCP::Discoveryengine::Schema"])).toEqual(
      resolveAll(["GCP::Pubsub::Schema", "GCP::Discoveryengine::Schema"], reserved),
    );
  });

  test("a newcomer whose short name only published types share is still prefixed", () => {
    const reserved = {
      "GCP::Bigquery::Job": "BQJob",
      "GCP::Cloudscheduler::Job": "CloudschedulerJob",
    };
    expect(
      resolveAll(
        ["GCP::Bigquery::Job", "GCP::Cloudscheduler::Job", "GCP::Transcoder::Job", "GCP::Example::Widget"],
        reserved,
      ),
    ).toEqual({
      "GCP::Bigquery::Job": "BQJob",
      "GCP::Cloudscheduler::Job": "CloudschedulerJob",
      "GCP::Transcoder::Job": "TranscoderJob",
      "GCP::Example::Widget": "Widget",
    });
  });

  test("a second generation over the snapshot the first one wrote names every type the same", () => {
    const types = ["GCP::Pubsub::Schema", "GCP::Discoveryengine::Schema", "GCP::Transcoder::Job", "GCP::Bigquery::Job"];
    const first = resolveAll(types, { "GCP::Pubsub::Schema": "Schema", "GCP::Bigquery::Job": "BQJob" });
    const written = Object.fromEntries(Object.entries(first).map(([t, n]) => [t, n!]));
    expect(resolveAll(types, written)).toEqual(first);
  });

  test("a snapshot that cannot be parsed reserves nothing", () => {
    expect(publishedNames(join(import.meta.dirname, "naming.test.ts"))).toEqual({});
  });

  describe("the Config Connector v1.161.0 collisions", () => {
    // A few of the names the v1.161.0 upgrade (#5512) would have renamed,
    // as the snapshot before it records them.
    const snapshot = {
      entries: {
        API: { kind: "resource", resourceType: "GCP::Apigateway::API" },
        Note: { kind: "resource", resourceType: "GCP::Containeranalysis::Note" },
        Note_Attestation: { kind: "property", resourceType: "GCP::Containeranalysis::Note.attestation" },
        Schema: { kind: "resource", resourceType: "GCP::Pubsub::Schema" },
        Tenant: { kind: "resource", resourceType: "GCP::Identityplatform::Tenant" },
        Workload: { kind: "resource", resourceType: "GCP::Assuredworkloads::Workload" },
      },
    };
    const types = [
      "GCP::Apigateway::API",
      "GCP::Apigeeregistry::API",
      "GCP::Apihub::API",
      "GCP::Containeranalysis::Note",
      "GCP::Grafeas::Note",
      "GCP::Pubsub::Schema",
      "GCP::Discoveryengine::Schema",
      "GCP::Identityplatform::Tenant",
      "GCP::Cloudtalentsolution::Tenant",
      "GCP::Saasservicemgmt::Tenant",
      "GCP::Assuredworkloads::Workload",
      "GCP::Apphub::Workload",
    ];

    test("the published types keep their bare names and only the newcomers are prefixed", () => {
      expect(resolveAll(types, reservedNamesFromSnapshot(snapshot))).toEqual({
        "GCP::Apigateway::API": "API",
        "GCP::Apigeeregistry::API": "ApigeeregistryAPI",
        "GCP::Apihub::API": "ApihubAPI",
        "GCP::Containeranalysis::Note": "Note",
        "GCP::Grafeas::Note": "GrafeasNote",
        "GCP::Pubsub::Schema": "Schema",
        "GCP::Discoveryengine::Schema": "DiscoveryengineSchema",
        "GCP::Identityplatform::Tenant": "Tenant",
        "GCP::Cloudtalentsolution::Tenant": "CloudtalentsolutionTenant",
        "GCP::Saasservicemgmt::Tenant": "SaasservicemgmtTenant",
        "GCP::Assuredworkloads::Workload": "Workload",
        "GCP::Apphub::Workload": "ApphubWorkload",
      });
    });

    test("property type names follow their resource, so they keep their names too", () => {
      const naming = new NamingStrategy(types.map(makeResult), reservedNamesFromSnapshot(snapshot));
      expect(propertyTypeName(naming.resolve("GCP::Containeranalysis::Note")!, "Attestation")).toBe("Note_Attestation");
      expect(propertyTypeName(naming.resolve("GCP::Grafeas::Note")!, "Attestation")).toBe("GrafeasNote_Attestation");
    });

    test("without the snapshot the same input renames the published types, as the rule alone did", () => {
      const names = resolveAll(types);
      expect(names["GCP::Containeranalysis::Note"]).toBe("ContaineranalysisNote");
      expect(names["GCP::Pubsub::Schema"]).toBe("PubSubSchema");
      expect(names["GCP::Apigateway::API"]).toBe("ApigatewayAPI");
    });
  });
});
