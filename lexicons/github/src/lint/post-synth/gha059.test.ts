import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha059, findStalePinAnnotations } from "./gha059";

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

const SHA_A = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const SHA_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("GHA059: stale or missing pin annotation", () => {
  test("flags a SHA-pinned ref with no trailing comment", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA_A}
`;
    const diags = gha059.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA059");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("no trailing version comment");
  });

  test("does not flag a SHA-pinned ref with a comment", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA_A} # v4.0.2
`;
    expect(gha059.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("treats a bare '# ' with nothing after it as missing", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA_A} #
`;
    const diags = gha059.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("no trailing version comment");
  });

  test("flags the same commit annotated with two different labels (mismatch)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA_A} # v4.0.2
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA_A} # v4.0.3
`;
    const diags = gha059.check(makeCtx(yaml));
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.severity === "warning")).toBe(true);
    expect(diags.every((d) => d.message.includes("internally inconsistent"))).toBe(true);
  });

  test("flags the same label attached to two different commits (mismatch)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA_A} # v4.0.2
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA_B} # v4.0.2
`;
    const diags = gha059.check(makeCtx(yaml));
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.message.includes("internally inconsistent"))).toBe(true);
  });

  test("does not flag two different actions annotated independently", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA_A} # v4.0.2
      - uses: actions/setup-go@${SHA_B} # v5.0.0
`;
    expect(findStalePinAnnotations(yaml)).toHaveLength(0);
  });

  test("does not flag a tag/branch-pinned ref (owned by GHA029)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
`;
    expect(findStalePinAnnotations(yaml)).toHaveLength(0);
  });

  test("does not flag local or docker references", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/local
      - uses: docker://alpine@sha256:abc
`;
    expect(findStalePinAnnotations(yaml)).toHaveLength(0);
  });
});
