/**
 * The generated pull-request workflow for Forgejo Actions (#3183): github's
 * workflow with the Forgejo dialect applied and its commands talking to
 * Forgejo. The whole file has a golden, and actionlint checks it when it is
 * installed, less the two things it cannot know about Forgejo: the runner
 * label and actions referenced by URL.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

const GOLDEN = join(import.meta.dirname, "__fixtures__", "pr-loop.forgejo.golden.yml");

function hasActionlint(): boolean {
  try {
    execFileSync("actionlint", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("the Forgejo pull-request workflow", () => {
  const result = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: {} });

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, result.yaml);
    expect(result.yaml).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("its commands talk to Forgejo, on Forgejo's runner, with no permissions block", () => {
    expect(result.yaml).toContain("--forge forgejo");
    expect(result.yaml).not.toContain("--forge github");
    expect(result.yaml).toContain("runs-on: docker");
    expect(result.yaml).not.toMatch(/^\s+permissions:/m);
  });

  test.skipIf(!hasActionlint())("passes actionlint, less the runner label and actions by URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-actionlint-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, ".github", "workflows", "chant-pr.yml"), result.yaml);
      const ignore = ['label "docker" is unknown', "invalid format because owner and repo and ref should not be empty"];
      expect(() =>
        execFileSync("actionlint", [...ignore.flatMap((p) => ["-ignore", p]), ".github/workflows/chant-pr.yml"], { cwd: dir, encoding: "utf8" }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
