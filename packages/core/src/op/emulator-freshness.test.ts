/**
 * Generalized from `lexicons/fly/src/emulator-freshness.test.ts` (#1345), which
 * covered fly's two pins. The check now reads every lexicon's declared spec.
 */

import { describe, test, expect } from "vitest";
import { compare, parseVersion, latestRelease, checkFreshness, formatResult, unpinned } from "./emulator-freshness";
import type { EmulatorSpec } from "./emulator-lifecycle";

const spec = (over: Partial<EmulatorSpec> = {}): EmulatorSpec => ({
  name: "chant-x",
  image: "org/x:1.0.0",
  containerPort: 1,
  healthPath: "/h",
  ...over,
});

describe("parseVersion", () => {
  test("reads the tag off an image ref", () => {
    expect(parseVersion("ghcr.io/intentius/mudflaps:0.4.1")).toBe("0.4.1");
  });

  test("strips a leading v", () => {
    expect(parseVersion("floci/floci:v1.5.34")).toBe("1.5.34");
  });

  test("a registry port is not a tag", () => {
    // `localhost:5000/floci` has a colon before the last slash.
    expect(parseVersion("localhost:5000/floci")).toBe("");
  });

  test("an untagged ref has no version", () => {
    expect(parseVersion("floci/floci")).toBe("");
  });
});

describe("compare", () => {
  test("behind when latest is newer", () => {
    expect(compare("x", "0.4.1", "0.5.0").behind).toBe(true);
  });

  test("current when equal", () => {
    expect(compare("x", "1.5.34", "1.5.34").behind).toBe(false);
  });

  test("not behind when the pin is ahead of the latest release", () => {
    expect(compare("x", "2.0.0", "1.9.9").behind).toBe(false);
  });

  test("compares numerically, not lexically", () => {
    // "10" < "9" as strings; the whole point of the parse.
    expect(compare("x", "1.9.0", "1.10.0").behind).toBe(true);
  });

  test("a shorter version is padded with zeros", () => {
    expect(compare("x", "1.5", "1.5.1").behind).toBe(true);
    expect(compare("x", "1.5", "1.5.0").behind).toBe(false);
  });

  test("normalizes the v prefix out of the report", () => {
    expect(compare("x", "v1.0.0", "v1.0.1")).toMatchObject({ pinned: "1.0.0", latest: "1.0.1" });
  });
});

describe("unpinned", () => {
  test("flags a floating tag", () => {
    expect(unpinned([spec({ image: "floci/floci:latest" })]).map((s) => s.name)).toEqual(["chant-x"]);
  });

  test("flags an untagged image", () => {
    expect(unpinned([spec({ image: "floci/floci" })])).toHaveLength(1);
  });

  test("a pinned image is not flagged", () => {
    expect(unpinned([spec()])).toEqual([]);
  });
});

describe("checkFreshness", () => {
  const fakeFetch = (tag: string) =>
    (async () => ({ ok: true, json: async () => ({ tag_name: tag }) })) as unknown as typeof fetch;

  test("checks each spec that declares an upstream", async () => {
    const results = await checkFreshness(
      [spec({ name: "a", upstream: { repo: "o/a" } }), spec({ name: "b", upstream: { repo: "o/b" } })],
      fakeFetch("1.0.0"),
    );
    expect(results.map((r) => r.name)).toEqual(["a", "b"]);
  });

  test("skips a spec with no upstream — a locally built image has no release feed", async () => {
    expect(await checkFreshness([spec()], fakeFetch("9.9.9"))).toEqual([]);
  });

  test("skips a spec whose image carries no version", async () => {
    expect(
      await checkFreshness([spec({ image: "floci/floci", upstream: { repo: "o/a" } })], fakeFetch("1.0.0")),
    ).toEqual([]);
  });

  test("reports behind when the release is newer than the pin", async () => {
    const [result] = await checkFreshness(
      [spec({ image: "org/x:1.0.0", upstream: { repo: "o/x" } })],
      fakeFetch("1.2.0"),
    );
    expect(result).toMatchObject({ pinned: "1.0.0", latest: "1.2.0", behind: true });
  });
});

describe("latestRelease", () => {
  test("returns the tag name", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ tag_name: "v2.1.0" }) })) as unknown as typeof fetch;
    expect(await latestRelease("o/r", fetchImpl)).toBe("v2.1.0");
  });

  test("throws on a non-ok response rather than reporting a bogus version", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(latestRelease("o/r", fetchImpl)).rejects.toThrow("HTTP 404");
  });

  test("throws when the release has no tag", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(latestRelease("o/r", fetchImpl)).rejects.toThrow("no tag_name");
  });
});

describe("formatResult", () => {
  test("marks a behind pin", () => {
    expect(formatResult(compare("chant-floci", "1.0.0", "1.1.0"))).toContain("behind");
  });

  test("marks a current pin", () => {
    expect(formatResult(compare("chant-floci", "1.1.0", "1.1.0"))).toContain("current");
  });
});
