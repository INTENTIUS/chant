import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { githubContextTools, downstreamJobs, actionPinned } from "./context-tools";

const tools = Object.fromEntries(githubContextTools().map((t) => [t.name, t]));

async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
  return tools[name].handler(params);
}

describe("downstreamJobs / actionPinned (#327)", () => {
  test("downstreamJobs follows the needs chain transitively", () => {
    const yaml = `jobs:
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
    expect(downstreamJobs(yaml, "build").sort()).toEqual(["deploy", "test"]);
    expect(downstreamJobs(yaml, "test")).toEqual(["deploy"]);
    expect(downstreamJobs(yaml, "deploy")).toEqual([]);
  });

  test("actionPinned only accepts a full commit SHA", () => {
    expect(actionPinned("actions/checkout@" + "a".repeat(40))).toBe(true);
    expect(actionPinned("actions/checkout@v4")).toBe(false);
    expect(actionPinned("actions/checkout@main")).toBe(false);
  });
});

describe("github context tools — end to end (#327)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `chant-mcp-gh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workflow.github.ts"),
      `const M = Symbol.for("chant.declarable");
export const ci = { [M]: true, lexicon: "github", entityType: "GitHub::Actions::Workflow", kind: "resource",
  props: {
    name: "CI",
    on: { push: { branches: ["main"] } },
    permissions: { contents: "read" },
    jobs: {
      build: { runsOn: "ubuntu-latest", steps: [ { uses: "peter-evans/create-pull-request@v6" }, { run: "npm ci" } ] },
      test: { runsOn: "ubuntu-latest", needs: ["build"], steps: [ { run: "npm test" } ] },
    },
  } };
`,
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("github:workflow returns triggers and jobs", async () => {
    const out = (await call("github:workflow", { path: dir })) as {
      workflow: string | null;
      triggers: string[];
      jobs: Array<{ name: string; runsAfter: string[]; steps: number }>;
    };
    expect(out.workflow).toBe("CI");
    expect(out.triggers).toContain("push");
    const names = out.jobs.map((j) => j.name);
    expect(names).toEqual(expect.arrayContaining(["build", "test"]));
    expect(out.jobs.find((j) => j.name === "test")?.runsAfter).toContain("build");
  });

  test("github:references reports the unpinned third-party action", async () => {
    const out = (await call("github:references", { path: dir })) as Array<{ kind: string; source: string; pinned: boolean }>;
    const action = out.find((r) => r.kind === "action" && r.source === "peter-evans/create-pull-request@v6");
    expect(action).toBeDefined();
    expect(action?.pinned).toBe(false);
  });

  test("github:checks returns the GHA findings (unpinned action trips GHA029)", async () => {
    const out = (await call("github:checks", { path: dir })) as { findings: Array<{ id: string; severity: string; job: string | null; message: string }> };
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.findings.some((f) => f.id === "GHA029")).toBe(true);
    for (const f of out.findings) {
      expect(typeof f.id).toBe("string");
      expect(typeof f.message).toBe("string");
    }
  });

  test("github:affected lists downstream jobs", async () => {
    const out = (await call("github:affected", { path: dir, job: "build" })) as { job: string; wouldRerun: string[] };
    expect(out.wouldRerun).toContain("test");
  });

  test("github:workflow-yaml returns the generated YAML for a path", async () => {
    const out = (await call("github:workflow-yaml", { path: dir })) as { yaml: string };
    expect(typeof out.yaml).toBe("string");
    expect(out.yaml).toContain("jobs:");
  });
});
