import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha006 } from "./gha006";
import { gha009 } from "./gha009";
import { gha011 } from "./gha011";
import { gha017 } from "./gha017";
import { gha018 } from "./gha018";
import { gha019 } from "./gha019";

// ── Helpers ─────────────────────────────────────────────────────────

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

// ── GHA006: Duplicate Workflow Name ─────────────────────────────────

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
});

// ── GHA009: Empty Matrix Dimension ──────────────────────────────────

describe("GHA009: empty matrix dimension", () => {
  test("flags empty matrix array", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: []
    steps:
      - run: echo test
`;
    const diags = gha009.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA009");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("node-version");
  });

  test("does not flag non-empty matrix", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - run: echo test
`;
    const diags = gha009.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── GHA011: Invalid Needs Reference ─────────────────────────────────

describe("GHA011: invalid needs reference", () => {
  test("flags needs referencing non-existent job", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  deploy:
    runs-on: ubuntu-latest
    needs: [build, test]
    steps:
      - run: echo deploy
`;
    const diags = gha011.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA011");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("test");
    expect(diags[0].message).toContain("deploy");
  });

  test("does not flag valid needs", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  deploy:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - run: echo deploy
`;
    const diags = gha011.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── GHA017: Missing Permissions ─────────────────────────────────────

describe("GHA017: missing permissions", () => {
  test("flags workflow without permissions", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha017.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA017");
    expect(diags[0].severity).toBe("info");
  });

  test("does not flag workflow with permissions", () => {
    const yaml = `name: CI
on:
  push:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha017.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── GHA018: PR Target + Checkout ────────────────────────────────────

describe("GHA018: pull_request_target + checkout", () => {
  test("flags pull_request_target with checkout", () => {
    const yaml = `name: CI
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const diags = gha018.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA018");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("checkout");
  });

  test("does not flag pull_request_target without checkout", () => {
    const yaml = `name: CI
on:
  pull_request_target:
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - run: echo "label"
`;
    const diags = gha018.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag push trigger with checkout", () => {
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
    const diags = gha018.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});

// ── GHA019: Circular Needs ──────────────────────────────────────────

describe("GHA019: circular needs chain", () => {
  test("detects simple cycle", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    needs: [deploy]
    steps:
      - run: echo build
  deploy:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - run: echo deploy
`;
    const diags = gha019.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("GHA019");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("→");
  });

  test("detects three-node cycle", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  a-job:
    runs-on: ubuntu-latest
    needs: [c-job]
    steps:
      - run: echo a
  b-job:
    runs-on: ubuntu-latest
    needs: [a-job]
    steps:
      - run: echo b
  c-job:
    runs-on: ubuntu-latest
    needs: [b-job]
    steps:
      - run: echo c
`;
    const diags = gha019.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("GHA019");
  });

  test("does not flag acyclic graph", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - run: echo test
  deploy:
    runs-on: ubuntu-latest
    needs: [test]
    steps:
      - run: echo deploy
`;
    const diags = gha019.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
