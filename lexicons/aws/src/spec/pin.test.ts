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

  test("refuses a drifted archive — generation does not proceed", () => {
    expect(() => assertPinnedSpec(archive("AWS::A::One", "AWS::B::Two"), { pin, pinnedNames: names, env: {} }))
      .toThrow(/upstream CloudFormation schema has moved/);
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
