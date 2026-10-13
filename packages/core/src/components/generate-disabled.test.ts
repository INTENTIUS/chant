/**
 * `chant build --components --generate <forge>` leaves out a component with
 * `enabled: false` (#3951), the same way `chant run --components all` skips it
 * (#1522): no job for it, and no other job needs it. Runs against the real
 * GitHub, GitLab and Forgejo plugins, not a stand-in, so each forge's own
 * `needs` rendering is what the assertions read.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateComponentsPipeline, resolveComponentTargets } from "./cli-support";

describe.each(["github", "gitlab", "forgejo"])("generateComponentsPipeline %s: enabled: false (#3951)", (forge) => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-generate-disabled-${forge}-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, "tunnel.component.ts"),
      `export const tunnel = { name: "tunnel", enabled: false, dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell", reason: "t" }] }] };`,
    );
    await writeFile(
      join(testDir, "db.component.ts"),
      `export const db = { name: "db", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell", reason: "t" }] }] };`,
    );
    await writeFile(
      join(testDir, "api.component.ts"),
      `export const api = { name: "api", dependsOn: ["db", "tunnel"], deploy: [{ phase: "Apply", steps: [{ kind: "shell", reason: "t" }] }] };`,
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("the disabled component has no job, and its dependent no longer needs it", async () => {
    const result = await generateComponentsPipeline(testDir, forge, { env: "prod" });

    expect(result.success).toBe(true);
    expect(result.jobs?.map((j) => j.component).sort()).toEqual(["api", "db"]);
    const api = result.jobs?.find((j) => j.component === "api");
    const db = result.jobs?.find((j) => j.component === "db");
    expect(api?.needs).toEqual([db?.jobName]);
    expect(result.yaml).not.toMatch(/tunnel/);
  });

  test("the pipeline holds the components an \"all\" run takes", async () => {
    const result = await generateComponentsPipeline(testDir, forge, { env: "prod" });
    const run = await resolveComponentTargets(testDir, "all");

    expect(result.jobs?.map((j) => j.component).sort()).toEqual(run.targets.map((t) => t.name).sort());
  });
});
