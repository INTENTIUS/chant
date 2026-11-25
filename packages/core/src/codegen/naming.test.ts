import { join } from "node:path";
import { describe, test, expect } from "vitest";
import {
  NamingStrategy,
  nameSchemas,
  publishedNamingConfig,
  readPublishedNames,
  readPublishedSources,
  reservedNamesFromSnapshot,
  type NamingConfig,
  type NamingInput,
} from "./naming";

/**
 * chant #1459 — a published TypeScript name belongs to the type that published
 * it, so an unrelated upstream addition or removal cannot rename a resource
 * whose own schema never moved.
 */

const config: NamingConfig = {
  priorityNames: {},
  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: {},
  shortName: (t) => t.split("::").pop() ?? t,
  serviceName: (t) => t.split("::")[1] ?? "",
};

function name(types: string[], over: Partial<NamingConfig> = {}): Map<string, string | undefined> {
  const inputs: NamingInput[] = types.map((typeName) => ({ typeName, propertyTypes: [] }));
  const strategy = new NamingStrategy(inputs, { ...config, ...over });
  return new Map(types.map((t) => [t, strategy.resolve(t)]));
}

describe("reservedNamesFromSnapshot", () => {
  test("inverts the snapshot into spec type → published name", () => {
    expect(
      reservedNamesFromSnapshot({
        entries: { MacieSession: { kind: "resource", resourceType: "AWS::Macie::Session" } },
      }),
    ).toEqual({ "AWS::Macie::Session": "MacieSession" });
  });

  test("reserves resources only, not property types", () => {
    // Property names derive from their owning resource (phase 5), so pinning
    // the resource pins them; reserving them separately would freeze aliases
    // that are meant to follow their parent.
    const reserved = reservedNamesFromSnapshot({
      entries: {
        Bucket: { kind: "resource", resourceType: "AWS::S3::Bucket" },
        Bucket_Rule: { kind: "property", resourceType: "AWS::S3::Bucket.Rule" },
      },
    });
    expect(reserved).toEqual({ "AWS::S3::Bucket": "Bucket" });
  });

  test("ignores entries with no resourceType, and a missing snapshot", () => {
    expect(reservedNamesFromSnapshot({ entries: { Broken: { kind: "resource" } } })).toEqual({});
    expect(reservedNamesFromSnapshot(undefined)).toEqual({});
    expect(reservedNamesFromSnapshot({})).toEqual({});
  });

  test("first writer wins when one spec type is listed under two names", () => {
    const reserved = reservedNamesFromSnapshot({
      entries: {
        Alpha: { kind: "resource", resourceType: "AWS::X::Y" },
        Beta: { kind: "resource", resourceType: "AWS::X::Y" },
      },
    });
    expect(reserved).toEqual({ "AWS::X::Y": "Alpha" });
  });

  test("interface names come from interface entries and from a registry entry's interface field", () => {
    const snapshot = {
      entries: {
        Bucket: { kind: "resource", resourceType: "AWS::S3::Bucket" },
        DeploymentSpec: { kind: "interface", resourceType: "io.k8s.api.apps.v1.DeploymentSpec" },
        Endpoint: { kind: "property", resourceType: "K8s::Monitoring::ServiceMonitor.endpoints", interface: "io.k8s.api.discovery.v1.Endpoint" },
      },
    };
    expect(reservedNamesFromSnapshot(snapshot, "interface")).toEqual({
      "io.k8s.api.apps.v1.DeploymentSpec": "DeploymentSpec",
      "io.k8s.api.discovery.v1.Endpoint": "Endpoint",
    });
    expect(reservedNamesFromSnapshot(snapshot)).toEqual({ "AWS::S3::Bucket": "Bucket" });
  });
});

describe("reserved names survive their neighbours changing", () => {
  test("a competitor disappearing does not hand its short name over", () => {
    // The real case: AWS::Athena::Session and AWS::SSM::Session were removed
    // upstream, which silently renamed AWS::Macie::Session from MacieSession
    // to Session — breaking a resource AWS had not touched.
    const withCompetitor = name(["AWS::Macie::Session", "AWS::Athena::Session"]);
    expect(withCompetitor.get("AWS::Macie::Session")).toBe("MacieSession");

    const afterRemoval = name(["AWS::Macie::Session"], {
      reservedNames: { "AWS::Macie::Session": "MacieSession" },
    });
    expect(afterRemoval.get("AWS::Macie::Session")).toBe("MacieSession");
  });

  test("without reservation, the same removal renames it — the bug", () => {
    const afterRemoval = name(["AWS::Macie::Session"]);
    expect(afterRemoval.get("AWS::Macie::Session")).toBe("Session");
  });

  test("a newcomer colliding gets qualified instead of displacing the incumbent", () => {
    // AWS::QuickSight::Space appearing renamed AWS::SageMaker::Space from
    // Space to SageMakerSpace. The newcomer should absorb the qualification.
    const names = name(["AWS::SageMaker::Space", "AWS::QuickSight::Space"], {
      reservedNames: { "AWS::SageMaker::Space": "Space" },
    });
    expect(names.get("AWS::SageMaker::Space")).toBe("Space");
    expect(names.get("AWS::QuickSight::Space")).toBe("QuickSightSpace");
  });

  test("order of the input does not decide the outcome", () => {
    const reservedNames = { "AWS::SageMaker::Space": "Space" };
    const forward = name(["AWS::SageMaker::Space", "AWS::QuickSight::Space"], { reservedNames });
    const reverse = name(["AWS::QuickSight::Space", "AWS::SageMaker::Space"], { reservedNames });
    expect(forward.get("AWS::SageMaker::Space")).toBe(reverse.get("AWS::SageMaker::Space"));
    expect(forward.get("AWS::QuickSight::Space")).toBe(reverse.get("AWS::QuickSight::Space"));
  });
});

describe("reservation boundaries", () => {
  test("an explicit priority name still outranks history", () => {
    const names = name(["AWS::Macie::Session"], {
      priorityNames: { "AWS::Macie::Session": "PinnedName" },
      reservedNames: { "AWS::Macie::Session": "MacieSession" },
    });
    expect(names.get("AWS::Macie::Session")).toBe("PinnedName");
  });

  test("a reservation for a type no longer in the input releases the name", () => {
    // AWS::CodeArtifact::Package was genuinely removed, so Package is free for
    // whoever legitimately claims it next.
    const names = name(["AWS::Panorama::Package"], {
      reservedNames: { "AWS::CodeArtifact::Package": "Package" },
    });
    expect(names.get("AWS::Panorama::Package")).toBe("Package");
  });

  test("a brand-new resource with no reservation is unaffected", () => {
    const names = name(["AWS::MSK::Channel"], { reservedNames: { "AWS::Macie::Session": "MacieSession" } });
    expect(names.get("AWS::MSK::Channel")).toBe("Channel");
  });

  test("no reservations at all reproduces the previous behaviour exactly", () => {
    const types = ["AWS::Macie::Session", "AWS::Athena::Session", "AWS::MSK::Channel"];
    expect(name(types, { reservedNames: {} })).toEqual(name(types));
  });
});

describe("publishedNamingConfig (#5551)", () => {
  const resolveAll = (types: string[], published: Record<string, string>, over: Partial<NamingConfig> = {}) => {
    const inputs: NamingInput[] = types.map((typeName) => ({ typeName, propertyTypes: [] }));
    const strategy = new NamingStrategy(inputs, publishedNamingConfig(inputs, { ...config, ...over }, published));
    return Object.fromEntries(types.map((t) => [t, strategy.resolve(t)]));
  };

  test("a newcomer sharing a published short name is prefixed and the published type keeps its name", () => {
    const types = ["Cloud::Pubsub::Schema", "Cloud::Discovery::Schema", "Cloud::Compute::Instance"];
    const names = resolveAll(types, { "Cloud::Pubsub::Schema": "Schema" });
    expect(names).toEqual({
      "Cloud::Pubsub::Schema": "Schema",
      "Cloud::Discovery::Schema": "DiscoverySchema",
      "Cloud::Compute::Instance": "Instance",
    });
    expect(resolveAll([...types].reverse(), { "Cloud::Pubsub::Schema": "Schema" })).toEqual(names);
  });

  test("a newcomer whose short name only published, prefixed types share is still prefixed", () => {
    expect(
      resolveAll(["Cloud::Bigquery::Job", "Cloud::Dataflow::Job", "Cloud::Transcoder::Job", "Cloud::Example::Widget"], {
        "Cloud::Bigquery::Job": "BigqueryJob",
        "Cloud::Dataflow::Job": "DataflowJob",
      }),
    ).toEqual({
      "Cloud::Bigquery::Job": "BigqueryJob",
      "Cloud::Dataflow::Job": "DataflowJob",
      "Cloud::Transcoder::Job": "TranscoderJob",
      "Cloud::Example::Widget": "Widget",
    });
  });

  test("a type's own alias listed in the snapshot is not claimed as its primary name", () => {
    const over = { priorityAliases: { "Cloud::Batch::Job": ["BatchJob"] } };
    const published = { "Cloud::Batch::Job": "BatchJob", "Cloud::Batch::CronJob": "CronJob" };
    const types = ["Cloud::Batch::Job", "Cloud::Batch::CronJob"];
    expect(resolveAll(types, published, over)).toEqual({ "Cloud::Batch::Job": "Job", "Cloud::Batch::CronJob": "CronJob" });
  });

  test("with no published names the config is returned unchanged", () => {
    const inputs: NamingInput[] = [{ typeName: "Cloud::Pubsub::Schema", propertyTypes: [] }];
    expect(publishedNamingConfig(inputs, config, {})).toBe(config);
  });

  test("a second generation over the names the first one wrote names every type the same", () => {
    const types = ["Cloud::Pubsub::Schema", "Cloud::Discovery::Schema", "Cloud::Transcoder::Job", "Cloud::Bigquery::Job"];
    const first = resolveAll(types, { "Cloud::Pubsub::Schema": "Schema", "Cloud::Bigquery::Job": "BigqueryJob" });
    const written = Object.fromEntries(Object.entries(first).map(([t, n]) => [t, n!]));
    expect(resolveAll(types, written)).toEqual(first);
  });

  test("a missing or unparseable snapshot reserves nothing", () => {
    expect(readPublishedNames(join(import.meta.dirname, "no-such-dir", "surface.snapshot.json"))).toEqual({});
    expect(readPublishedNames(join(import.meta.dirname, "naming.test.ts"))).toEqual({});
  });
});

describe("nameSchemas (#5569)", () => {
  const rule = {
    lexicon: "test",
    short: (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/Input$/, ""),
    qualified: (s: string) => `Q${s.charAt(0).toUpperCase()}${s.slice(1)}`,
    held: ["Bucket"],
  };

  test("a schema keeps its published name and a newcomer sharing it is qualified", () => {
    const names = nameSchemas(["thingInput", "thing", "other"], rule, { thing: "Thing" });
    expect([...names]).toEqual([
      ["thingInput", "QThingInput"],
      ["thing", "Thing"],
      ["other", "Other"],
    ]);
  });

  test("without published names every schema sharing a short name is qualified", () => {
    expect(Object.fromEntries(nameSchemas(["thing", "thingInput"], rule))).toEqual({
      thing: "QThing",
      thingInput: "QThingInput",
    });
  });

  test("a held name is never taken, and two schemas left with one name are refused", () => {
    expect(Object.fromEntries(nameSchemas(["bucket"], rule))).toEqual({ bucket: "QBucket" });
    expect(() => nameSchemas(["thing"], rule, { other: "Thing", thing: "Other" })).not.toThrow();
    expect(() => nameSchemas(["Thing", "thing"], { ...rule, qualified: () => "Same" })).toThrow(
      /test codegen: schema thing would take the type name Same, which schema Thing holds/,
    );
  });

  test("readPublishedSources reads property sources, and nothing from a missing file", () => {
    expect(readPublishedSources(join(import.meta.dirname, "no-such-dir", "surface.snapshot.json"))).toEqual({});
    expect(
      reservedNamesFromSnapshot(
        { entries: { Thing: { kind: "property", resourceType: "T::S::Thing" }, B: { kind: "resource", resourceType: "T::S::B" } } },
        "property",
      ),
    ).toEqual({ "T::S::Thing": "Thing" });
  });
});
