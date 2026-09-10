import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { augurSerializer, collectProfiles } from "./serializer";
import { Profile } from "./resources";

const entities = (pairs: Array<[string, Declarable]>): Map<string, Declarable> => new Map(pairs);

describe("the augur serializer", () => {
  it("writes the declared profiles, and only those", () => {
    const out = augurSerializer.serialize(
      entities([
        ["peak", new Profile({ traffic: "1000 rps, p99", description: "Friday evening" }) as Declarable],
        ["steady", new Profile({ traffic: "100 rps, p50" }) as Declarable],
      ]),
    );
    expect(JSON.parse(out as string)).toEqual({
      augur: "augur/profiles/v1",
      profiles: [
        { name: "peak", traffic: "1000 rps, p99", description: "Friday evening" },
        { name: "steady", traffic: "100 rps, p50" },
      ],
    });
  });

  it("sorts by name, so two builds that discovered them in two orders agree", () => {
    const forwards = augurSerializer.serialize(
      entities([
        ["a", new Profile({ traffic: "10 rps" }) as Declarable],
        ["z", new Profile({ traffic: "20 rps" }) as Declarable],
      ]),
    );
    const backwards = augurSerializer.serialize(
      entities([
        ["z", new Profile({ traffic: "20 rps" }) as Declarable],
        ["a", new Profile({ traffic: "10 rps" }) as Declarable],
      ]),
    );
    expect(backwards).toBe(forwards);
  });

  it("ends with one newline, and is byte-stable across calls", () => {
    const map = entities([["steady", new Profile({ traffic: "100 rps, p50" }) as Declarable]]);
    const first = augurSerializer.serialize(map) as string;
    expect(first.endsWith("}\n")).toBe(true);
    expect(augurSerializer.serialize(map)).toBe(first);
  });

  it("emits an empty profile list rather than nothing, for a project that declares none", () => {
    // Not an empty string: a reader of the artifact should be able to tell
    // "this project declares no levels" from "augur wrote nothing here".
    expect(JSON.parse(augurSerializer.serialize(new Map()) as string)).toEqual({
      augur: "augur/profiles/v1",
      profiles: [],
    });
  });

  it("leaves a foreign entity in the partition alone", () => {
    const foreign = { entityType: "AWS::S3::Bucket", kind: "resource", lexicon: "aws", props: {} } as unknown as Declarable;
    expect(collectProfiles(entities([["bucket", foreign]]))).toEqual([]);
  });

  it("carries a missing traffic level through as empty rather than inventing one", () => {
    // AUG001 reports it at lint time and AUG101 skips it; the serializer's job
    // is to write what was declared, not to guess a level nobody named.
    expect(collectProfiles(entities([["broken", new Profile({}) as Declarable]]))).toEqual([
      { name: "broken", traffic: "" },
    ]);
  });
});
