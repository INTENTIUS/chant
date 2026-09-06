import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveRootModeSync } from "./resolve-root-mode";

const dirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-tf-resolve-root-mode-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveRootModeSync (#2106)", () => {
  test("live: choudoufu binary and a declared estate", () => {
    const project = tempProject();
    mkdirSync(join(project, "root"), { recursive: true });
    writeFileSync(
      join(project, "root", "main.tf"),
      ["terraform {", "  live {", '    estate = "fixture-estate"', "  }", "}", ""].join("\n"),
    );
    writeFileSync(
      join(project, "chant.config.json"),
      JSON.stringify({ terraform: { binary: "choudoufu", roots: { app: { dir: "./root" } } } }),
    );
    expect(resolveRootModeSync("app", project)).toEqual({ mode: "live", dir: join(project, "root") });
  });

  test("state: choudoufu binary but no declared estate", () => {
    const project = tempProject();
    mkdirSync(join(project, "root"), { recursive: true });
    writeFileSync(join(project, "root", "main.tf"), 'resource "null_resource" "x" {}\n');
    writeFileSync(
      join(project, "chant.config.json"),
      JSON.stringify({ terraform: { binary: "choudoufu", roots: { app: { dir: "./root" } } } }),
    );
    expect(resolveRootModeSync("app", project)).toEqual({ mode: "state", dir: join(project, "root") });
  });

  test("state: no binary declared at all, root dir need not even exist", () => {
    const project = tempProject();
    writeFileSync(join(project, "chant.config.json"), JSON.stringify({ terraform: { roots: { app: { dir: "./root" } } } }));
    expect(resolveRootModeSync("app", project)).toEqual({ mode: "state", dir: join(project, "root") });
  });

  test("undefined: no chant.config.json findable from cwd", () => {
    const project = tempProject();
    expect(resolveRootModeSync("app", project)).toBeUndefined();
  });

  test("undefined: config found is chant.config.ts, not .json", () => {
    const project = tempProject();
    writeFileSync(join(project, "chant.config.ts"), "export default {} as const;\n");
    expect(resolveRootModeSync("app", project)).toBeUndefined();
  });

  test("undefined: config exists but names no such root", () => {
    const project = tempProject();
    writeFileSync(
      join(project, "chant.config.json"),
      JSON.stringify({ terraform: { binary: "choudoufu", roots: { other: { dir: "./root" } } } }),
    );
    expect(resolveRootModeSync("app", project)).toBeUndefined();
  });

  test("undefined: choudoufu binary but the root directory does not exist", () => {
    const project = tempProject();
    writeFileSync(
      join(project, "chant.config.json"),
      JSON.stringify({ terraform: { binary: "choudoufu", roots: { app: { dir: "./missing" } } } }),
    );
    expect(resolveRootModeSync("app", project)).toBeUndefined();
  });

  test("defaults cwd to process.cwd() when omitted", () => {
    // No assertion on the result (process.cwd() during a test run is
    // unpredictable), only that it does not throw with no argument.
    expect(() => resolveRootModeSync("app")).not.toThrow();
  });
});
