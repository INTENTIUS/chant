import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { gha006 } from "./gha006";

function makeMultiCtx(files: Record<string, string>): PostSynthContext {
  const result = {
    primary: Object.values(files)[0] ?? "",
    files,
  };
  return {
    outputs: new Map([["github", result as unknown as string]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["github", result as unknown as string]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("GHA006: duplicate workflow name", () => {
  test("flags duplicate workflow names across files", () => {
    const ctx = makeMultiCtx({
      "ci.yml": `name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n`,
      "deploy.yml": `name: CI\non:\n  push:\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n`,
    });
    const diags = gha006.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA006");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("CI");
  });

  test("does not flag unique workflow names", () => {
    const ctx = makeMultiCtx({
      "ci.yml": `name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n`,
      "deploy.yml": `name: Deploy\non:\n  push:\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n`,
    });
    const diags = gha006.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags three files with same name", () => {
    const ctx = makeMultiCtx({
      "a.yml": `name: Build\non:\n  push:\njobs:\n  a:\n    runs-on: ubuntu-latest\n`,
      "b.yml": `name: Build\non:\n  push:\njobs:\n  b:\n    runs-on: ubuntu-latest\n`,
      "c.yml": `name: Build\non:\n  push:\njobs:\n  c:\n    runs-on: ubuntu-latest\n`,
    });
    const diags = gha006.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Build");
  });
});
