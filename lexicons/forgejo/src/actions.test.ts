import { describe, test, expect } from "vitest";
import { resolveActionRef, DEFAULT_ACTIONS_ROOT } from "./actions";

describe("resolveActionRef — mapped actions", () => {
  test("rewrites actions/checkout@v4 under the default actions root", () => {
    const { rewritten, warning } = resolveActionRef("actions/checkout@v4");
    expect(rewritten).toBe(`${DEFAULT_ACTIONS_ROOT}/actions/checkout@v4`);
    expect(warning).toBeUndefined();
  });

  test("rewrites the common actions/* set", () => {
    for (const name of [
      "actions/setup-node",
      "actions/setup-go",
      "actions/setup-python",
      "actions/cache",
      "actions/upload-artifact",
      "actions/download-artifact",
    ]) {
      const { rewritten, warning } = resolveActionRef(`${name}@v4`);
      expect(rewritten).toBe(`${DEFAULT_ACTIONS_ROOT}/${name}@v4`);
      expect(warning).toBeUndefined();
    }
  });

  test("pins docker/* to a full GitHub URL, independent of the actions root", () => {
    const { rewritten, warning } = resolveActionRef("docker/build-push-action@v5", {
      actionsRoot: "https://example.test",
    });
    expect(rewritten).toBe("https://github.com/docker/build-push-action@v5");
    expect(warning).toBeUndefined();
  });

  test("preserves a subpath", () => {
    const { rewritten } = resolveActionRef("actions/cache/restore@v4");
    expect(rewritten).toBe(`${DEFAULT_ACTIONS_ROOT}/actions/cache/restore@v4`);
  });

  test("handles a ref with no version", () => {
    const { rewritten } = resolveActionRef("actions/checkout");
    expect(rewritten).toBe(`${DEFAULT_ACTIONS_ROOT}/actions/checkout`);
  });
});

describe("resolveActionRef — actionsRoot override", () => {
  test("override changes the base for mirrored actions", () => {
    const { rewritten } = resolveActionRef("actions/checkout@v4", {
      actionsRoot: "https://codeberg.org",
    });
    expect(rewritten).toBe("https://codeberg.org/actions/checkout@v4");
  });

  test("a trailing slash on the root is normalized", () => {
    const { rewritten } = resolveActionRef("actions/checkout@v4", {
      actionsRoot: "https://codeberg.org/",
    });
    expect(rewritten).toBe("https://codeberg.org/actions/checkout@v4");
  });
});

describe("resolveActionRef — unmapped refs", () => {
  test("passes an unmapped owner/repo through and reports it", () => {
    const { rewritten, warning } = resolveActionRef("some-org/custom-action@v1");
    expect(rewritten).toBe("some-org/custom-action@v1");
    expect(warning).toBeDefined();
    expect(warning).toContain("some-org/custom-action@v1");
  });
});

describe("resolveActionRef — already-resolvable refs", () => {
  test.each([
    "./.forgejo/actions/local",
    "../shared/action",
    "docker://alpine:3.20",
    "https://codeberg.org/actions/checkout@v4",
    "http://example.test/x@v1",
  ])("leaves %s untouched without warning", (ref) => {
    const { rewritten, warning } = resolveActionRef(ref);
    expect(rewritten).toBe(ref);
    expect(warning).toBeUndefined();
  });
});
