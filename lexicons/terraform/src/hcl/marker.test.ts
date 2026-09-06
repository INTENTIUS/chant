/**
 * The marker escaping rule, held to choudoufu's own spec (#2104).
 *
 * Every case in the first two `it.each` tables is a row copied verbatim from
 * `live/MARKERS.md` in https://github.com/INTENTIUS/choudoufu, spec version 1:
 * the "Escaping rule" table and the "for_each key escaping" table. They are
 * the contract, so they are the test, and a change to either side shows up
 * here rather than in a live estate.
 */

import { describe, expect, it } from "vitest";
import {
  addressMatches,
  escapeAddress,
  escapeAddressVariants,
  escapeForEachKey,
  joinMarkerAddress,
  readMarker,
  MARKER_TAG_ADDRESS,
  MARKER_TAG_ESTATE,
  MARKER_TAG_SLOT,
} from "./marker";

describe("escapeAddress: live/MARKERS.md's own Escaping rule table", () => {
  it.each([
    ["aws_vpc.this", "aws_vpc.this"],
    ['aws_subnet.this["a"]', "aws_subnet.this:a"],
    ["aws_eip.this[2]", "aws_eip.this:2"],
    ['module.subnets["a"].aws_subnet.this', "module.subnets:a.aws_subnet.this"],
    ["module.subnets[2].aws_subnet.this", "module.subnets:2.aws_subnet.this"],
    ['aws_subnet.this["alice.smith"]', "aws_subnet.this:alice@dsmith"],
    ['aws_subnet.this["at@sign"]', "aws_subnet.this:at@@sign"],
  ])("%s escapes to %s", (unescaped, escaped) => {
    expect(escapeAddress(unescaped)).toBe(escaped);
  });

  it("leaves no AWS-forbidden character in the value", () => {
    for (const address of ['aws_subnet.this["a.b:c@d"]', "module.m[3].aws_eip.pool[10]"]) {
      expect(escapeAddress(address)).not.toMatch(/[[\]"]/);
    }
  });
});

describe("escapeForEachKey: live/MARKERS.md's own for_each key escaping table", () => {
  it.each([
    ["a(b)", "a+000028b+000029"],
    ["plus+one", "plus++one"],
    ["a;b", "a+00003Bb"],
  ])("%s escapes to %s", (raw, escaped) => {
    expect(escapeForEachKey(raw)).toBe(escaped);
  });

  it("doubles @, then . , then : , in that order", () => {
    expect(escapeForEachKey("at@sign")).toBe("at@@sign");
    expect(escapeForEachKey("alice.smith")).toBe("alice@dsmith");
    expect(escapeForEachKey("a:b")).toBe("a@cb");
    // The order is load-bearing: the `@` the `.` rule introduces must not be
    // doubled again by the `@` rule.
    expect(escapeForEachKey("a.b")).toBe("a@db");
  });

  it("runs the out-of-charset layer before the doubling", () => {
    // `(` leaves as `+000028`, which contains no @, . or : for the second
    // layer to touch, and the key's own `.` is still doubled.
    expect(escapeForEachKey("a(b).c")).toBe("a+000028b+000029@dc");
  });

  it("leaves a key already inside the AWS-legal set alone, `+` excepted", () => {
    expect(escapeForEachKey("us-east-1a")).toBe("us-east-1a");
    expect(escapeForEachKey("10.0.0.0/16")).toBe("10@d0@d0@d0/16");
  });
});

describe("addressMatches: escape the declared address, compare strings", () => {
  it("matches the current escaping", () => {
    expect(addressMatches('aws_subnet.this["a"]', "aws_subnet.this:a")).toBe(true);
  });

  it("matches a marker stamped before the out-of-charset layer landed", () => {
    // `a.b+c` stamped as `a@db+c` in the window between choudoufu #178 and
    // #210: the `.` doubled, the `+` untouched.
    expect(addressMatches('aws_subnet.this["a.b+c"]', "aws_subnet.this:a@db+c")).toBe(true);
    expect(escapeAddress('aws_subnet.this["a.b+c"]')).toBe("aws_subnet.this:a@db++c");
  });

  it("matches a marker stamped before any key escaping at all", () => {
    expect(addressMatches('aws_subnet.this["at@sign"]', "aws_subnet.this:at@sign")).toBe(true);
  });

  it("collapses the three escapings to one for an address with no for_each key", () => {
    expect(escapeAddressVariants("aws_vpc.this")).toEqual(["aws_vpc.this"]);
  });

  it("refuses a value that is not any escaping of the declared address", () => {
    expect(addressMatches("aws_vpc.this", "aws_vpc.other")).toBe(false);
  });
});

describe("joinMarkerAddress: the continuation chain", () => {
  it("returns the head alone when no continuation is present", () => {
    expect(joinMarkerAddress({ [MARKER_TAG_ADDRESS]: "aws_vpc.this" })).toBe("aws_vpc.this");
  });

  it("concatenates tofu-address, then -2, then -3, then -4, in order", () => {
    expect(
      joinMarkerAddress({
        [MARKER_TAG_ADDRESS]: "aaa",
        "tofu-address-2": "bbb",
        "tofu-address-3": "ccc",
        "tofu-address-4": "ddd",
      }),
    ).toBe("aaabbbcccddd");
  });

  it("reads a chain with a gap as unreadable, never as the address up to the gap", () => {
    expect(joinMarkerAddress({ [MARKER_TAG_ADDRESS]: "aaa", "tofu-address-3": "ccc" })).toBeUndefined();
  });
});

describe("readMarker: live/MARKERS.md's Ownership semantics", () => {
  it("a tofu-estate value is the whole ownership claim", () => {
    expect(
      readMarker({ [MARKER_TAG_ESTATE]: "prod", [MARKER_TAG_ADDRESS]: "aws_vpc.this" }),
    ).toEqual({ kind: "owned", estate: "prod", address: "aws_vpc.this" });
  });

  it("carries the slot when a count instance has one", () => {
    expect(
      readMarker({
        [MARKER_TAG_ESTATE]: "prod",
        [MARKER_TAG_ADDRESS]: "aws_eip.pool:1",
        [MARKER_TAG_SLOT]: "1",
      }),
    ).toEqual({ kind: "owned", estate: "prod", address: "aws_eip.pool:1", slot: "1" });
  });

  it("neither key present is foreign", () => {
    expect(readMarker({ Name: "someone else's" })).toEqual({ kind: "foreign" });
    expect(readMarker(undefined)).toEqual({ kind: "foreign" });
  });

  it("an estate with no readable address is malformed, not foreign and not owned", () => {
    const verdict = readMarker({ [MARKER_TAG_ESTATE]: "prod" });
    expect(verdict.kind).toBe("malformed");
    expect(verdict).toMatchObject({ estate: "prod" });
  });
});
