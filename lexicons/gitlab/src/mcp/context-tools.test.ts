import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitlabContextTools, downstreamJobs, componentPinned } from "./context-tools";

const tools = Object.fromEntries(gitlabContextTools().map((t) => [t.name, t]));

async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
  return tools[name].handler(params);
}

describe("downstreamJobs / componentPinned (#327)", () => {
  test("downstreamJobs follows the needs chain transitively", () => {
    const yaml = `build:
  stage: build
  script:
    - echo build

test:
  stage: test
  needs:
    - build
  script:
    - echo test

deploy:
  stage: deploy
  needs:
    - test
  script:
    - echo deploy
`;
    expect(downstreamJobs(yaml, "build").sort()).toEqual(["deploy", "test"]);
    expect(downstreamJobs(yaml, "test")).toEqual(["deploy"]);
    expect(downstreamJobs(yaml, "deploy")).toEqual([]);
  });

  test("componentPinned recognises a fixed version", () => {
    expect(componentPinned("gitlab.com/g/comp@1.2.3")).toBe(true);
    expect(componentPinned("gitlab.com/g/comp@main")).toBe(false);
  });
});

describe("gitlab context tools — end to end (#327/#328)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `chant-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "pipeline.infra.ts"),
      `const M = Symbol.for("chant.declarable");
export const buildApp = { [M]: true, lexicon: "gitlab", entityType: "GitLab::CI::Job", kind: "resource",
  props: { stage: "build", image: { name: "node:20" }, script: ["echo build"] } };
export const testApp = { [M]: true, lexicon: "gitlab", entityType: "GitLab::CI::Job", kind: "resource",
  props: { stage: "test", script: ["npm test"], needs: ["build-app"] } };
`,
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("gitlab:pipeline returns stages and jobs", async () => {
    const out = (await call("gitlab:pipeline", { path: dir })) as {
      stages: string[];
      jobs: Array<{ name: string; stage: string | null; runsAfter: string[] }>;
    };
    expect(out.stages).toEqual(expect.arrayContaining(["build", "test"]));
    const names = out.jobs.map((j) => j.name);
    expect(names).toEqual(expect.arrayContaining(["build-app", "test-app"]));
    expect(out.jobs.find((j) => j.name === "test-app")?.runsAfter).toContain("build-app");
  });

  test("gitlab:references reports the unpinned image", async () => {
    const out = (await call("gitlab:references", { path: dir })) as Array<{ kind: string; source: string; pinned: boolean | null }>;
    const img = out.find((r) => r.kind === "image" && r.source === "node:20");
    expect(img).toBeDefined();
    expect(img?.pinned).toBe(false);
  });

  test("gitlab:checks returns the WGL findings (unpinned image trips WGL031)", async () => {
    const out = (await call("gitlab:checks", { path: dir })) as { findings: Array<{ id: string; severity: string; job: string | null; message: string }> };
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.findings.some((f) => f.id === "WGL031")).toBe(true);
    for (const f of out.findings) {
      expect(typeof f.id).toBe("string");
      expect(typeof f.message).toBe("string");
    }
  });

  test("gitlab:affected lists downstream jobs", async () => {
    const out = (await call("gitlab:affected", { path: dir, job: "build-app" })) as { job: string; wouldRerun: string[] };
    expect(out.wouldRerun).toContain("test-app");
  });

  test("gitlab:pipeline-yaml returns the generated YAML for a path", async () => {
    const out = (await call("gitlab:pipeline-yaml", { path: dir })) as { yaml: string };
    expect(typeof out.yaml).toBe("string");
    expect(out.yaml).toContain("stages:");
  });

  test("gitlab:source traces a job back to its declaring file", async () => {
    const out = (await call("gitlab:source", { path: dir, job: "build-app" })) as {
      job: string; found: boolean; entity: string; from: string | null; via: string | null;
    };
    expect(out.found).toBe(true);
    expect(out.entity).toBe("buildApp");
    expect(out.from).toMatch(/pipeline\.infra\.ts$/);
    expect(out.via).toBeNull(); // plain declarable, not from a composite
  });

  test("gitlab:source reports not-found for an unknown job", async () => {
    const out = (await call("gitlab:source", { path: dir, job: "nope" })) as { job: string; found: boolean };
    expect(out.found).toBe(false);
  });

  test("gitlab:owns reports a declared job as owned, an unknown one as not", async () => {
    const owned = (await call("gitlab:owns", { path: dir, job: "test-app" })) as { owned: boolean; basis: string };
    expect(owned.owned).toBe(true);
    expect(owned.basis).toBe("declared-in-source");
    const foreign = (await call("gitlab:owns", { path: dir, job: "not-here" })) as { owned: boolean };
    expect(foreign.owned).toBe(false);
  });
});
