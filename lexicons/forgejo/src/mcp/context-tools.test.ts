/**
 * Smoke tests for the forgejo read-only context tools. Each builds a small
 * temp project from source and exercises the tool handler directly.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { forgejoContextTools } from "./context-tools";

const SOURCE = `import { Workflow, Job, Step, Checkout } from "@intentius/chant-lexicon-forgejo";

export const workflow = new Workflow({
  name: "CI",
  on: { push: { branches: ["main"] } },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    Checkout({}).step,
    new Step({ name: "Custom", uses: "some-org/custom-action@v1" }),
    new Step({ name: "Test", run: "npm test" }),
  ],
});

export const deploy = new Job({
  "runs-on": "ubuntu-latest",
  needs: ["build"],
  steps: [new Step({ name: "Deploy", run: "./deploy.sh" })],
});
`;

let dir: string;
const tools = forgejoContextTools();
const tool = (name: string) => tools.find((t) => t.name === name)!;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fj-ctx-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "pipeline.ts"), SOURCE);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("forgejo context tools", () => {
  test("all expected tools are registered", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "forgejo:checks",
      "forgejo:workflow",
      "forgejo:references",
      "forgejo:affected",
      "forgejo:workflow-yaml",
      "forgejo:source",
      "forgejo:owns",
      "forgejo:compare",
    ]);
  });

  test("forgejo:workflow returns triggers and jobs", async () => {
    const result = (await tool("forgejo:workflow").handler({ path: join(dir, "src") })) as {
      workflow: string;
      triggers: string[];
      jobs: Array<{ name: string; runsAfter: string[] }>;
    };
    expect(result.workflow).toBe("CI");
    expect(result.triggers).toContain("push");
    expect(result.jobs.map((j) => j.name).sort()).toEqual(["build", "deploy"]);
  });

  test("forgejo:references reports the rewritten + unmapped refs", async () => {
    const refs = (await tool("forgejo:references").handler({ path: join(dir, "src") })) as Array<{ source: string }>;
    const sources = refs.map((r) => r.source);
    expect(sources).toContain("https://code.forgejo.org/actions/checkout@v4");
    expect(sources).toContain("some-org/custom-action@v1");
  });

  test("forgejo:checks surfaces the unresolved ref (WFJ010)", async () => {
    const result = (await tool("forgejo:checks").handler({ path: join(dir, "src") })) as {
      findings: Array<{ id: string }>;
    };
    expect(result.findings.some((f) => f.id === "WFJ010")).toBe(true);
  });

  test("forgejo:affected traces the needs chain", async () => {
    const result = (await tool("forgejo:affected").handler({ path: join(dir, "src"), job: "build" })) as {
      wouldRerun: string[];
    };
    expect(result.wouldRerun).toContain("deploy");
  });

  test("forgejo:owns reports a declared job as owned", async () => {
    const result = (await tool("forgejo:owns").handler({ path: join(dir, "src"), job: "build" })) as { owned: boolean };
    expect(result.owned).toBe(true);
  });
});
