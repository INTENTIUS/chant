import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha051 } from "./gha051";

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

describe("GHA051: publish with long-lived token instead of OIDC", () => {
  test("flags npm publish with a token secret and no id-token", () => {
    const yaml = `name: Release
on:
  push:
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
        run: npm publish
`;
    const diags = gha051.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA051");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].entity).toBe("publish");
  });

  test("does not flag when id-token: write is requested", () => {
    const yaml = `name: Release
on:
  push:
permissions:
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
        run: npm publish
`;
    const diags = gha051.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag a non-publish job", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - env:
          API: \${{ secrets.API_TOKEN }}
        run: npm run build
`;
    const diags = gha051.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
