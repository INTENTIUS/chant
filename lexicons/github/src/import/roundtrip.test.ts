import { describe, test, expect } from "vitest";
import { GitHubActionsParser } from "./parser";
import { GitHubActionsGenerator } from "./generator";

const parser = new GitHubActionsParser();
const generator = new GitHubActionsGenerator();

describe("roundtrip: parse → generate", () => {
  test("simple CI workflow roundtrip", () => {
    const yaml = `
name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
`;
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);

    expect(files).toHaveLength(1);
    const content = files[0].content;

    expect(content).toContain("import");
    expect(content).toContain("export const");
    expect(content).toContain("new Workflow(");
    expect(content).toContain("new Job(");
    expect(content).toContain("CI");
    expect(content).toContain("npm ci");
    expect(content).toContain("npm test");
  });

  test("multi-job workflow roundtrip", () => {
    const yaml = `
name: Build and Deploy
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm run build
  test:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - uses: actions/checkout@v4
      - run: npm test
  deploy:
    runs-on: ubuntu-latest
    needs: [test]
    steps:
      - run: echo "deploy"
`;
    const ir = parser.parse(yaml);
    expect(ir.resources.length).toBeGreaterThanOrEqual(3);

    const files = generator.generate(ir);
    const content = files[0].content;

    expect(content).toContain("new Workflow(");
    expect(content).toContain("new Job(");
    expect(content).toContain("build");
    expect(content).toContain("test");
    expect(content).toContain("deploy");
    expect(content).toContain("needs");
  });

  test("matrix strategy roundtrip", () => {
    const yaml = `
name: Matrix
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]
      fail-fast: false
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);
    const content = files[0].content;

    expect(content).toContain("matrix");
    expect(content).toContain("node-version");
  });

  test("concurrency and permissions roundtrip", () => {
    const yaml = `
name: Deploy
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
concurrency:
  group: deploy
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);
    const content = files[0].content;

    expect(content).toContain("concurrency");
    expect(content).toContain("permissions");
    expect(content).toContain("deploy");
  });

  test("reusable workflow call roundtrip", () => {
    const yaml = `
name: Caller
on:
  push:
jobs:
  call-deploy:
    uses: ./.github/workflows/deploy.yml
    with:
      environment: production
    secrets: inherit
`;
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);
    const content = files[0].content;

    expect(content).toContain("Workflow");
    expect(content).toContain("export const");
  });

  test("workflow dispatch with inputs roundtrip", () => {
    const yaml = `
name: Manual Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: "Target environment"
        required: true
        type: choice
        options:
          - staging
          - production
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploying
`;
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);
    const content = files[0].content;

    expect(content).toContain("import");
    expect(content).toContain("export const");
    expect(content).toContain("Manual Deploy");
    expect(content).toContain("workflow_dispatch");
  });

  test("environment protection roundtrip", () => {
    const yaml = `
name: Production Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://example.com
    steps:
      - run: deploy.sh
`;
    const ir = parser.parse(yaml);
    const files = generator.generate(ir);
    const content = files[0].content;

    expect(content).toContain("environment");
    expect(content).toContain("production");
  });
});
