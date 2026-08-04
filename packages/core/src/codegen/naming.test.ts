import { describe, test, expect } from "vitest";
import { NamingStrategy, reservedNamesFromSnapshot, type NamingConfig, type NamingInput } from "./naming";

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
