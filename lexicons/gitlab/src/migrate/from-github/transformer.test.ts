import { describe, test, expect } from "vitest";
import { transform, detectGitHubWorkflow } from "./index";

describe("detectGitHubWorkflow", () => {
  test("recognises a minimal GH workflow", () => {
    const yml = `name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hello\n`;
    expect(detectGitHubWorkflow(yml)).toBe(true);
  });

  test("rejects unrelated YAML", () => {
    const yml = `stages:\n  - build\nbuild-job:\n  script:\n    - make\n`;
    expect(detectGitHubWorkflow(yml)).toBe(false);
  });
});

describe("transform — minimal workflow", () => {
  test("emits jobs at top level + stages", async () => {
    const yml = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm run build
  test:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - run: npm test
`;
    const result = await transform(yml, { sourceFile: "ci.yml" });
    expect(result.output).toContain("stages:");
    expect(result.output).toContain("build:");
    expect(result.output).toContain("test:");
    expect(result.output).toContain("- npm ci");
    expect(result.output).toContain("- npm test");
    expect(result.stages).toContain("build");
    expect(result.stages).toContain("test");
  });

  test("workflow name → workflow.name", async () => {
    const yml = `name: My CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`;
    const result = await transform(yml);
    expect(result.output).toMatch(/workflow:[\s\S]*name:/);
  });

  test("runs-on: ubuntu-latest → image: ubuntu:24.04", async () => {
    const yml = `on: push
jobs:
  job1:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const result = await transform(yml);
    expect(result.output).toContain("ubuntu:24.04");
  });

  test("env at workflow + job level lands in variables", async () => {
    const yml = `on: push
env:
  TOP: top-value
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      JOBVAR: job-value
    steps:
      - run: echo $TOP $JOBVAR
`;
    const result = await transform(yml);
    expect(result.output).toContain("TOP");
    expect(result.output).toContain("JOBVAR");
  });

  test("matrix → parallel.matrix", async () => {
    const yml = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
        os: [ubuntu, windows]
    steps:
      - run: echo testing
`;
    const result = await transform(yml);
    expect(result.output).toContain("parallel:");
    expect(result.output).toContain("matrix:");
    expect(result.output).toContain("NODE");
    expect(result.output).toContain("OS");
  });

  test("timeout-minutes → timeout", async () => {
    const yml = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: make
`;
    const result = await transform(yml);
    expect(result.output).toMatch(/timeout:\s*'?30 minutes'?/);
  });

  test("continue-on-error → allow_failure", async () => {
    const yml = `on: push
jobs:
  flaky:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: maybe-fail
`;
    const result = await transform(yml);
    expect(result.output).toMatch(/allow_failure:\s*true/);
  });

  test("if: github.ref == 'refs/heads/main' translates", async () => {
    const yml = `on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - run: ./deploy.sh
`;
    const result = await transform(yml);
    expect(result.output).toContain("$CI_COMMIT_REF_NAME");
    expect(result.output).toContain("rules:");
  });

  test("permissions emits needs-review", async () => {
    const yml = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: make
`;
    const result = await transform(yml);
    expect(result.provenance.some((p) => p.rule === "MIG-PERMISSIONS-001")).toBe(true);
  });

  test("actions/checkout becomes a no-op skip (Tier 1 registry)", async () => {
    const yml = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const result = await transform(yml);
    // With Tier 1 registry, actions/checkout is intentionally skipped
    expect(result.provenance.some((p) => p.rule === "ACT-actions-checkout" && p.category === "skipped")).toBe(true);
    // npm test still emitted
    expect(result.output).toContain("- npm test");
  });

  test("unknown action emits MIG-ACTION-UNKNOWN", async () => {
    const yml = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: some-org/never-mapped-action@v1
      - run: echo done
`;
    const result = await transform(yml);
    expect(result.provenance.some((p) => p.rule === "MIG-ACTION-UNKNOWN")).toBe(true);
  });
});

describe("transform — provenance + diagnostics", () => {
  test("clean translation emits no error diagnostics", async () => {
    const yml = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    const result = await transform(yml);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  test("strict escalates needs-review to error", async () => {
    const yml = `on: schedule
jobs:
  cron:
    runs-on: ubuntu-latest
    steps:
      - run: ./run.sh
`;
    const result = await transform(yml, { strict: true });
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("ir.metadata.migration is set", async () => {
    const yml = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`;
    const result = await transform(yml, { sourceFile: "ci.yml" });
    expect(result.ir.metadata?.migration).toEqual({
      sourceFile: "ci.yml",
      sourceTool: "github-actions",
    });
  });
});
