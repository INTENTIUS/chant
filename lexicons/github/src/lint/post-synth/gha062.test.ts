import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha062, checkAdvisories } from "./gha062";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["github", yaml]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

const YAML = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA}
      - uses: actions/checkout@v4
`;

describe("GHA062: advisory cross-reference (feed-driven, graceful degrade)", () => {
  test("is silent when the wrapped check runs with no feed present", () => {
    expect(gha062.check(makeCtx(YAML))).toHaveLength(0);
  });

  test("checkAdvisories degrades to no findings when the feed argument is omitted", () => {
    expect(checkAdvisories(YAML)).toHaveLength(0);
  });

  test("checkAdvisories degrades to no findings for an explicitly empty feed", () => {
    expect(checkAdvisories(YAML, { entries: [] })).toHaveLength(0);
  });

  test("does not throw for an undefined feed", () => {
    expect(() => checkAdvisories(YAML, undefined)).not.toThrow();
  });

  test("flags a SHA-pinned ref matching a feed entry", () => {
    const diags = checkAdvisories(YAML, {
      entries: [{ slug: "actions/setup-node", shas: [SHA], id: "GHSA-xxxx-yyyy-zzzz", summary: "Arbitrary code execution", url: "https://example.com/advisory" }],
    });
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA062");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("GHSA-xxxx-yyyy-zzzz");
    expect(diags[0].message).toContain("actions/setup-node");
  });

  test("flags a tag-pinned ref matching a feed entry by ref", () => {
    const diags = checkAdvisories(YAML, {
      entries: [{ slug: "actions/checkout", refs: ["v4"], id: "GHSA-aaaa-bbbb-cccc", summary: "Path traversal" }],
    });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("actions/checkout@v4");
  });

  test("includes the patched-ref hint when the feed carries one", () => {
    const diags = checkAdvisories(YAML, {
      entries: [{ slug: "actions/setup-node", shas: [SHA], id: "GHSA-xxxx", summary: "Issue", patchedRef: "v4.1.0" }],
    });
    expect(diags[0].message).toContain("v4.1.0");
  });

  test("does not flag a reference the feed doesn't mention", () => {
    const diags = checkAdvisories(YAML, {
      entries: [{ slug: "some/other-action", shas: [SHA], id: "GHSA-xxxx", summary: "Unrelated" }],
    });
    expect(diags).toHaveLength(0);
  });

  test("does not flag when the SHA doesn't match the entry's affected list", () => {
    const diags = checkAdvisories(YAML, {
      entries: [{ slug: "actions/setup-node", shas: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], id: "GHSA-xxxx", summary: "Issue" }],
    });
    expect(diags).toHaveLength(0);
  });
});
