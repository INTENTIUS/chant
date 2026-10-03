import { describe, test, expect, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { pickLatest, resolverFor } from "./pinned-upgrade";
import type { UpstreamPin } from "../lexicon";

// Recorded shape of GET /repos/postgres/postgres/tags: names only, no releases exist.
const tags = JSON.parse(readFileSync(join(__dirname, "testdata", "postgres-tags.json"), "utf-8")) as Array<{
  name: string;
}>;

/** What a postgres pin declares: REL_18_6 maps to 18.6, everything else is skipped. */
const relTag = (t: string): string | null => {
  const m = /^REL_(\d+)_(\d+)$/.exec(t);
  return m ? `${m[1]}.${m[2]}` : null;
};

describe("pickLatest with tagVersion (postgres REL_ tags)", () => {
  test("maps REL_18_6 to 18.6 and picks the highest GA version", () => {
    expect(pickLatest(tags, "tags", { tagVersion: relTag })).toBe("18.6");
  });

  test("orders numerically, not lexically (17.11 beats 17.9)", () => {
    const t = ["REL_17_9", "REL_17_11", "REL_17_10"].map((name) => ({ name }));
    expect(pickLatest(t, "tags", { tagVersion: relTag })).toBe("17.11");
  });

  test("skips betas and release candidates even if the mapper would take them", () => {
    const t = ["REL_19_BETA4", "REL_18_RC1", "REL_18_BETA3", "REL_18_5"].map((name) => ({ name }));
    expect(pickLatest(t, "tags", { tagVersion: (x) => x.replace(/^REL_/, "").replace(/_/g, ".") })).toBe("18.5");
    expect(pickLatest(t, "tags", { tagVersion: relTag })).toBe("18.5");
  });

  test("sameMajorAs stays inside one major line", () => {
    expect(pickLatest(tags, "tags", { tagVersion: relTag, sameMajorAs: "17.9" })).toBe("17.11");
    expect(pickLatest(tags, "tags", { tagVersion: relTag, sameMajorAs: "14.1" })).toBe("14.24");
  });

  test("sameMajorAs accepts a pin that holds the raw tag", () => {
    expect(pickLatest(tags, "tags", { tagVersion: relTag, sameMajorAs: "REL_16_2" })).toBe("16.15");
  });

  test("a major with no stable tag yields null", () => {
    expect(pickLatest(tags, "tags", { tagVersion: relTag, sameMajorAs: "19.0" })).toBeNull();
  });
});

describe("pickLatest without the new options is unchanged", () => {
  test("REL_ tags are not versions, so nothing is found", () => {
    expect(pickLatest(tags, "tags")).toBeNull();
  });

  test("plain semver tags with a suffix filter and pre-release skip", () => {
    const t = ["v17.9.0-ee", "v17.10.0-rc1-ee", "v17.8.1-ee", "v18.0.0"].map((name) => ({ name }));
    expect(pickLatest(t, "tags", { tagSuffix: "-ee" })).toBe("v17.9.0-ee");
  });

  test("releases honour the prerelease flag", () => {
    const r = [
      { tag_name: "v1.33.0", prerelease: true },
      { tag_name: "v1.32.1" },
      { tag_name: "v1.32.0" },
    ];
    expect(pickLatest(r, "releases")).toBe("v1.32.1");
  });
});

describe("resolverFor reads every page of tags when tagVersion is set", () => {
  afterEach(() => vi.unstubAllGlobals());

  const pin = (upstream: Partial<UpstreamPin["upstream"]>): UpstreamPin => ({
    file: "src/spec/pin.ts",
    pattern: /x/,
    replace: (v, l) => l + v,
    upstream: { owner: "postgres", repo: "postgres", kind: "tags", ...upstream },
  });

  function stubPages(pages: Array<Array<{ name: string }>>) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const n = Number(new URL(url).searchParams.get("page"));
        return new Response(JSON.stringify(pages[n - 1] ?? []), { status: 200 });
      }),
    );
    return urls;
  }

  test("finds a version that is only on the second page", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ name: `REL9_${i}_0` }));
    const urls = stubPages([filler, [{ name: "REL_18_6" }, { name: "REL_18_BETA1" }]]);
    const latest = await resolverFor(pin({ tagVersion: relTag }), "18.5")();
    expect(latest).toBe("18.6");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("per_page=100&page=1");
  });

  test("trackMajor uses the pinned value", async () => {
    stubPages([tags]);
    expect(await resolverFor(pin({ tagVersion: relTag, trackMajor: true }), "16.2")()).toBe("16.15");
    expect(await resolverFor(pin({ tagVersion: relTag }), "16.2")()).toBe("18.6");
  });

  test("without tagVersion only the first page is read, as before", async () => {
    const urls = stubPages([Array.from({ length: 50 }, () => ({ name: "v1.0.0" })), [{ name: "v9.0.0" }]]);
    expect(await resolverFor(pin({ kind: "tags" }), "v1.0.0")()).toBe("v1.0.0");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("per_page=50");
  });
});
