import { describe, test, expect } from "vitest";
import {
  parseVersion,
  compare,
  latestRelease,
  checkFreshness,
  formatResult,
  EMULATOR_PINS,
} from "./emulator-freshness";

describe("parseVersion", () => {
  test("extracts the version from a ghcr image ref, stripping a leading v", () => {
    expect(parseVersion("ghcr.io/intentius/mudflaps:0.3.1")).toBe("0.3.1");
    expect(parseVersion("ghcr.io/intentius/spritzer:v1.2.0")).toBe("1.2.0");
  });
});

describe("compare", () => {
  test("not behind when pinned equals latest", () => {
    expect(compare("mudflaps", "0.3.1", "v0.3.1").behind).toBe(false);
  });
  test("behind when latest is a newer patch/minor/major", () => {
    expect(compare("m", "0.3.1", "v0.3.2").behind).toBe(true);
    expect(compare("m", "0.3.1", "v0.4.0").behind).toBe(true);
    expect(compare("m", "0.3.1", "v1.0.0").behind).toBe(true);
  });
  test("not behind when pinned is ahead of latest", () => {
    expect(compare("m", "0.4.0", "v0.3.9").behind).toBe(false);
  });
  test("normalizes the leading v out of the reported versions", () => {
    const r = compare("m", "0.3.1", "v0.3.2");
    expect(r.pinned).toBe("0.3.1");
    expect(r.latest).toBe("0.3.2");
  });
});

describe("EMULATOR_PINS", () => {
  test("tracks mudflaps and spritzer from the single-source image constants", () => {
    expect(EMULATOR_PINS.map((p) => p.name).sort()).toEqual(["mudflaps", "spritzer"]);
    for (const p of EMULATOR_PINS) {
      expect(p.repo).toMatch(/^intentius\//);
      expect(p.pinned).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("latestRelease + checkFreshness (mocked fetch)", () => {
  const mkFetch = (tags: Record<string, string>): typeof fetch =>
    (async (url: string | URL | Request) => {
      const u = String(url);
      const repo = u.match(/repos\/([^/]+\/[^/]+)\/releases/)?.[1] ?? "";
      return { ok: true, status: 200, json: async () => ({ tag_name: tags[repo] }) } as Response;
    }) as unknown as typeof fetch;

  test("latestRelease returns the tag_name", async () => {
    const f = mkFetch({ "intentius/mudflaps": "v0.9.0" });
    expect(await latestRelease("intentius/mudflaps", f)).toBe("v0.9.0");
  });

  test("checkFreshness flags a pin behind its latest release", async () => {
    // Force both upstreams to a high version so the check reports behind
    // regardless of the currently-pinned tag.
    const f = mkFetch({ "intentius/mudflaps": "v99.0.0", "intentius/spritzer": "v99.0.0" });
    const results = await checkFreshness(f);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.behind)).toBe(true);
  });

  test("checkFreshness reports current when latest matches the pin", async () => {
    const pins = Object.fromEntries(EMULATOR_PINS.map((p) => [p.repo, `v${p.pinned}`]));
    const results = await checkFreshness(mkFetch(pins));
    expect(results.every((r) => !r.behind)).toBe(true);
  });

  test("latestRelease throws on a non-ok response", async () => {
    const f = (async () => ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch;
    await expect(latestRelease("intentius/nope", f)).rejects.toThrow(/HTTP 404/);
  });
});

describe("formatResult", () => {
  test("marks behind vs current distinctly", () => {
    expect(formatResult({ name: "m", pinned: "0.3.1", latest: "0.4.0", behind: true })).toMatch(/behind/);
    expect(formatResult({ name: "m", pinned: "0.3.1", latest: "0.3.1", behind: false })).toMatch(/current/);
  });
});
