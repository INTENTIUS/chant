import { describe, test, expect } from "vitest";
import {
  AWS_SPEC_PIN,
  PINNED_TYPE_NAMES,
  ACCEPT_ENV,
  specContentDigest,
  specDrift,
  driftMessage,
  assertPinnedSpec,
} from "./pin";

const schema = (typeName: string, extra = "") =>
  Buffer.from(JSON.stringify({ typeName, description: extra }));

const archive = (...names: string[]): Map<string, Buffer> =>
  new Map(names.map((n) => [n, schema(n)]));

const pinFor = (schemas: Map<string, Buffer>) => ({
  digest: specContentDigest(schemas),
  resources: schemas.size,
  accepted: "2026-01-01",
});

describe("specContentDigest (#1390)", () => {
  test("is stable across map insertion order", () => {
    // The zip's file order is not something to depend on.
    const a = archive("AWS::A::One", "AWS::B::Two");
    const b = new Map([...a.entries()].reverse());
    expect(specContentDigest(a)).toBe(specContentDigest(b));
  });

  test("changes when a schema's bytes change", () => {
    const before = archive("AWS::A::One");
    const after = new Map([["AWS::A::One", schema("AWS::A::One", "now documented")]]);
    expect(specContentDigest(after)).not.toBe(specContentDigest(before));
  });

  test("changes when a type is added", () => {
    expect(specContentDigest(archive("AWS::A::One", "AWS::B::Two"))).not.toBe(
      specContentDigest(archive("AWS::A::One")),
    );
  });

  test("changes when a type is removed", () => {
    expect(specContentDigest(archive("AWS::A::One"))).not.toBe(
      specContentDigest(archive("AWS::A::One", "AWS::B::Two")),
    );
  });

  test("an empty archive still digests", () => {
    expect(specContentDigest(new Map())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("specDrift", () => {
  const pinned = archive("AWS::A::One", "AWS::B::Two");
  const pin = pinFor(pinned);
  const names = new Set(pinned.keys());

  test("null when the content matches", () => {
    expect(specDrift(pinned, names, pin)).toBeNull();
  });

  test("names what was added", () => {
    const drifted = archive("AWS::A::One", "AWS::B::Two", "AWS::C::Three");
    expect(specDrift(drifted, names, pin)?.added).toEqual(["AWS::C::Three"]);
  });

  test("names what was removed", () => {
    expect(specDrift(archive("AWS::A::One"), names, pin)?.removed).toEqual(["AWS::B::Two"]);
  });

  test("a changed schema drifts with no added or removed types", () => {
    const changed = new Map(pinned);
    changed.set("AWS::A::One", schema("AWS::A::One", "changed"));
    const drift = specDrift(changed, names, pin);
    expect(drift).not.toBeNull();
    expect(drift!.added).toEqual([]);
    expect(drift!.removed).toEqual([]);
    expect(drift!.resources).toBe(pin.resources);
  });

  test("without a name set it still reports the count", () => {
    const drift = specDrift(archive("AWS::A::One"), undefined, pin);
    expect(drift?.resources).toBe(1);
    expect(drift?.added).toEqual([]);
  });
});

describe("driftMessage", () => {
  const pinned = archive("AWS::A::One", "AWS::B::Two");
  const pin = pinFor(pinned);
  const names = new Set(pinned.keys());

  test("states the count delta, not just that a digest differs", () => {
    const drift = specDrift(archive("AWS::A::One", "AWS::B::Two", "AWS::C::Three"), names, pin)!;
    expect(driftMessage(drift, pin)).toContain("+1 against the pin");
  });

  test("says so when only content changed", () => {
    const changed = new Map(pinned);
    changed.set("AWS::A::One", schema("AWS::A::One", "changed"));
    expect(driftMessage(specDrift(changed, names, pin)!, pin)).toContain("unchanged in count");
  });

  test("prints the block to paste into the pin", () => {
    const drift = specDrift(archive("AWS::A::One"), names, pin)!;
    const message = driftMessage(drift, pin);
    expect(message).toContain(`digest: "${drift.digest}"`);
    expect(message).toContain("resources: 1,");
  });

  test("truncates a long list rather than printing hundreds of names", () => {
    const many = archive("AWS::A::One", "AWS::B::Two", ...Array.from({ length: 9 }, (_, i) => `AWS::N::T${i}`));
    expect(driftMessage(specDrift(many, names, pin)!, pin)).toContain("+4 more");
  });
});

describe("assertPinnedSpec", () => {
  const pinned = archive("AWS::A::One");
  const pin = pinFor(pinned);
  const names = new Set(pinned.keys());

  test("passes when the archive matches", () => {
    expect(() => assertPinnedSpec(pinned, { pin, pinnedNames: names, env: {} })).not.toThrow();
  });

  test("reports a drifted archive — generation proceeds (#1473)", () => {
    // Was a throw. Enforcement moved to the release-time surface gate, so a
    // moving upstream can no longer redden an unrelated PR.
    const warnings: string[] = [];
    expect(() =>
      assertPinnedSpec(archive("AWS::A::One", "AWS::B::Two"), {
        pin, pinnedNames: names, env: {}, warn: (m) => warnings.push(m),
      }),
    ).not.toThrow();
    expect(warnings[0]).toMatch(/upstream CloudFormation schema has moved/);
  });

  test("the accept env proceeds and reports instead", () => {
    const warnings: string[] = [];
    expect(() =>
      assertPinnedSpec(archive("AWS::A::One", "AWS::B::Two"), {
        pin,
        pinnedNames: names,
        env: { [ACCEPT_ENV]: "1" },
        warn: (m) => warnings.push(m),
      }),
    ).not.toThrow();
    expect(warnings[0]).toContain("AWS::B::Two");
  });
});

describe("the committed pin", () => {
  test("records as many type names as it claims resources", () => {
    // A pin bumped without regenerating the name list would make every future
    // drift message wrong about what was added.
    expect(PINNED_TYPE_NAMES.size).toBe(AWS_SPEC_PIN.resources);
  });

  test("is a sha256 and an ISO date", () => {
    expect(AWS_SPEC_PIN.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(AWS_SPEC_PIN.accepted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("holds real CloudFormation type names", () => {
    expect(PINNED_TYPE_NAMES.has("AWS::S3::Bucket")).toBe(true);
    expect(PINNED_TYPE_NAMES.has("AWS::IAM::Role")).toBe(true);
  });
});

/**
 * chant #1473 — byte churn is a warning, a moved resource set is still a
 * refusal. The aws lexicon became unpublishable because upstream republishes
 * schemas several times a day and any digest mismatch was fatal.
 */
describe("byte churn vs a moved resource set (#1473)", () => {
  const pinned = archive("AWS::S3::Bucket", "AWS::IAM::Role");
  const pin = pinFor(pinned);
  const names = new Set(pinned.keys());

  function capture(schemas: Map<string, Buffer>) {
    const warnings: string[] = [];
    let threw: Error | undefined;
    try {
      assertPinnedSpec(schemas, { pin, pinnedNames: names, env: {}, warn: (m) => warnings.push(m) });
    } catch (err) {
      threw = err as Error;
    }
    return { warnings, threw };
  }

  test("same type set, different bytes — warns and proceeds", () => {
    // AWS editing a description in place. Three digests were observed in one
    // day this way, all with an unchanged resource count.
    const edited = new Map(pinned);
    edited.set("AWS::S3::Bucket", schema("AWS::S3::Bucket", "reworded"));

    const { warnings, threw } = capture(edited);
    expect(threw).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resource set is unchanged");
    expect(warnings[0]).toContain("surface.snapshot.json");
  });

  test("a type removed — reports loudly, does not throw", () => {
    // Enforcement is the release-time surface gate; a removed type always
    // shows up there. Throwing here made every aws PR hostage to upstream.
    const { warnings, threw } = capture(archive("AWS::S3::Bucket"));
    expect(threw).toBeUndefined();
    expect(warnings[0]).toContain("removed");
    expect(warnings[0]).toContain("Generation refuses");
  });

  test("a type added — reports loudly, does not throw", () => {
    const { warnings, threw } = capture(archive("AWS::S3::Bucket", "AWS::IAM::Role", "AWS::SQS::Queue"));
    expect(threw).toBeUndefined();
    expect(warnings[0]).toContain("added");
  });

  test("a moved type set is reported more urgently than byte churn", () => {
    const edited = new Map(pinned);
    edited.set("AWS::S3::Bucket", schema("AWS::S3::Bucket", "reworded"));
    expect(capture(edited).warnings[0]).toContain("resource set is unchanged");
    expect(capture(archive("AWS::S3::Bucket")).warnings[0]).not.toContain("resource set is unchanged");
  });

  test("an unchanged archive neither warns nor throws", () => {
    const { warnings, threw } = capture(new Map(pinned));
    expect(threw).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("generation is never blocked by the pin, whatever moved", () => {
    // The invariant that matters now: `generate` always completes. Whether the
    // result may SHIP is decided by the surface gate in validate.
    const edited = new Map(pinned);
    edited.set("AWS::S3::Bucket", schema("AWS::S3::Bucket", "reworded"));
    expect(() => assertPinnedSpec(edited, { pin, pinnedNames: new Set(), env: {}, warn: () => {} })).not.toThrow();
    expect(() => assertPinnedSpec(archive("AWS::X::Y"), { pin, pinnedNames: names, env: {}, warn: () => {} })).not.toThrow();
  });

  test("the accept env still short-circuits both cases", () => {
    const warnings: string[] = [];
    assertPinnedSpec(archive("AWS::S3::Bucket"), {
      pin,
      pinnedNames: names,
      env: { [ACCEPT_ENV]: "1" },
      warn: (m) => warnings.push(m),
    });
    expect(warnings[0]).toContain(ACCEPT_ENV);
  });

  test("the non-fatal message still prints a pastable pin block", () => {
    const edited = new Map(pinned);
    edited.set("AWS::IAM::Role", schema("AWS::IAM::Role", "reworded"));
    const { warnings } = capture(edited);
    expect(warnings[0]).toContain('  digest: "sha256:');
    expect(warnings[0]).toContain("  resources: 2,");
    // The one-off escape hatch is meaningless when nothing is being refused.
    expect(warnings[0]).not.toContain(ACCEPT_ENV);
  });
});
