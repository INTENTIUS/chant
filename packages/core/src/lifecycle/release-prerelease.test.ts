import { describe, expect, test } from "vitest";
import { prereleaseNote, prereleaseOf } from "./release-prerelease";
import { ociTags } from "./publish-oci";

describe("prereleaseOf", () => {
  test("a semver prerelease label maps to its id as the dist-tag", () => {
    expect(prereleaseOf("1.4.0-rc.1")).toEqual({ id: "rc", distTag: "rc" });
    expect(prereleaseOf("v2.0.0-beta.3")).toEqual({ id: "beta", distTag: "beta" });
    expect(prereleaseOf("2.0.0-RC.1+build.5")).toEqual({ id: "rc", distTag: "rc" });
    expect(prereleaseOf("1.0.0-alpha")).toEqual({ id: "alpha", distTag: "alpha" });
  });
  test("no usable id is next, and latest is never the tag", () => {
    expect(prereleaseOf("1.0.0-1")).toEqual({ id: null, distTag: "next" });
    expect(prereleaseOf("1.0.0-0.3.7")).toEqual({ id: null, distTag: "next" });
    expect(prereleaseOf("1.0.0-latest.1")).toEqual({ id: "latest", distTag: "next" });
  });
  test("a plain version, a build suffix alone, a date label and no label are not prereleases", () => {
    for (const l of ["1.4.0", "v1.4.0", "1.4.0+build.1", "2026-11-15", "v1", "", null, undefined]) expect(prereleaseOf(l)).toBeNull();
  });
  test("the note names the dist-tag, or the channel that wins over it", () => {
    expect(prereleaseNote("1.4.0-rc.1")).toContain("npm moves rc, not latest");
    expect(prereleaseNote("1.4.0-rc.1", "hotfix")).toContain("npm moves hotfix, not latest");
    expect(prereleaseNote("1.4.0")).toBe("");
  });
});

describe("ociTags for a prerelease label", () => {
  const decl = (tags?: string[]) => ({ type: "oci" as const, repository: "ghcr.io/acme/api", images: [], ...(tags ? { tags } : {}) }) as never;
  test("latest is dropped, the other declared tags stay", () => {
    expect(ociTags(decl(["{label}", "latest"]), { tag: null, label: "1.4.0-rc.1" })).toEqual(["1.4.0-rc.1"]);
    expect(ociTags(decl(["{label}", "latest"]), { tag: null, label: "1.4.0" })).toEqual(["1.4.0", "latest"]);
  });
  test("a declaration of latest alone falls back to the label tag", () => {
    expect(ociTags(decl(["latest"]), { tag: null, label: "1.4.0-rc.1" })).toEqual(["1.4.0-rc.1"]);
  });
  test("a channel on the cut still decides the tag", () => {
    expect(ociTags(decl(["{label}", "latest"]), { tag: "hotfix", label: "1.4.0-rc.1" })).toEqual(["hotfix"]);
  });
});
