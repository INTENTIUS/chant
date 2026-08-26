import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha060, findOverScopedTokens } from "./gha060";

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

describe("GHA060: over-scoped generated token", () => {
  test("flags a minted token whose output is never referenced (unused)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ vars.APP_ID }}
          private-key: \${{ secrets.APP_KEY }}
          permission-contents: write
      - run: echo build
`;
    const diags = gha060.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA060");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("no other step references its output");
    expect(diags[0].message).toContain("permission-contents");
  });

  test("flags a consumed token with no evidence of the granted write scope (no-signal)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ vars.APP_ID }}
          private-key: \${{ secrets.APP_KEY }}
          permission-contents: write
      - uses: actions/checkout@v4
        with:
          token: \${{ steps.app-token.outputs.token }}
`;
    const diags = gha060.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("no consuming step shows evidence");
    expect(diags[0].message).toContain("permission-contents");
  });

  test("does not flag when a consuming step evidences the granted scope", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ vars.APP_ID }}
          private-key: \${{ secrets.APP_KEY }}
          permission-contents: write
      - uses: actions/checkout@v4
        with:
          token: \${{ steps.app-token.outputs.token }}
      - run: |
          git push origin main
`;
    expect(findOverScopedTokens(yaml)).toHaveLength(0);
  });

  test("does not flag read-only permission scopes", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ vars.APP_ID }}
          private-key: \${{ secrets.APP_KEY }}
          permission-contents: read
      - run: echo build
`;
    expect(findOverScopedTokens(yaml)).toHaveLength(0);
  });

  test("does not flag steps unrelated to a token-minting action", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    expect(findOverScopedTokens(yaml)).toHaveLength(0);
  });

  test("recognizes the alternate app-token action slugs", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: app-token
        uses: tibdex/github-app-token@v2
        with:
          app_id: \${{ vars.APP_ID }}
          permission-issues: write
      - run: echo build
`;
    const found = findOverScopedTokens(yaml);
    expect(found).toHaveLength(1);
    expect(found[0].scopes).toEqual(["issues"]);
    expect(found[0].reason).toBe("unused");
  });
});
