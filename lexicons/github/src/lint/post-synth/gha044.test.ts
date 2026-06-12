import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha044 } from "./gha044";

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

describe("GHA044: hardcoded registry/container credential", () => {
  test("flags a hardcoded password literal", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/login-action@v3
        with:
          username: myuser
          password: hunter2
`;
    const diags = gha044.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA044");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag a password sourced from a secret", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/login-action@v3
        with:
          username: myuser
          password: \${{ secrets.DOCKER_PASSWORD }}
`;
    const diags = gha044.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
