import { describe, test, expect } from "vitest";
import { extractJobs, buildNeedsGraph } from "./yaml-helpers";

// The shape chant's serializer emits: every step starts with `name:`, and
// `run:` is often a block scalar. The line-based extractJobs read only the
// first line of a job's first step, so it saw none of these steps (#3201).
const NAME_FIRST = `name: CI
on:
  pull_request_target:
    branches:
      - main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v7 # v7.0.1
      - name: Setup Node
        uses: actions/setup-node@v7
        with:
          node-version: "22"
      - name: Test
        run: |
          npm ci
          npm test
  Publish_Docs:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Publish
        run: echo publish
  deploy:
    needs:
      - build
      - Publish_Docs
    runs-on: ubuntu-latest
    steps:
      - id: go
        name: Deploy
        run: echo deploy
`;

describe("extractJobs (#3201)", () => {
  test("reads every step of a job whose steps start with name:", () => {
    const build = extractJobs(NAME_FIRST).get("build");
    expect(build?.steps).toEqual([
      { name: "Checkout", uses: "actions/checkout@v7", run: undefined },
      { name: "Setup Node", uses: "actions/setup-node@v7", run: undefined },
      { name: "Test", uses: undefined, run: "npm ci\nnpm test\n" },
    ]);
  });

  test("reads a step whose first key is neither name, uses nor run", () => {
    expect(extractJobs(NAME_FIRST).get("deploy")?.steps).toEqual([
      { name: "Deploy", uses: undefined, run: "echo deploy" },
    ]);
  });

  test("reads job ids with capitals and underscores", () => {
    expect([...extractJobs(NAME_FIRST).keys()]).toEqual(["build", "Publish_Docs", "deploy"]);
  });

  test("reads needs as a scalar, a block list and a flow list", () => {
    const jobs = extractJobs(NAME_FIRST);
    expect(jobs.get("build")?.needs).toBeUndefined();
    expect(jobs.get("Publish_Docs")?.needs).toEqual(["build"]);
    expect(jobs.get("deploy")?.needs).toEqual(["build", "Publish_Docs"]);
    expect(extractJobs(`jobs:\n  a:\n    needs: [x, "y"]\n    runs-on: ubuntu-latest\n`).get("a")?.needs).toEqual(["x", "y"]);
  });

  test("buildNeedsGraph sees scalar needs", () => {
    expect(buildNeedsGraph(NAME_FIRST).get("Publish_Docs")).toEqual(["build"]);
  });

  test("a reusable-workflow job has no steps", () => {
    const jobs = extractJobs(`jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n`);
    expect(jobs.get("call")).toEqual({ name: "call" });
  });

  test("unparseable YAML yields no jobs", () => {
    expect(extractJobs("jobs:\n  a: [\n").size).toBe(0);
  });
});
