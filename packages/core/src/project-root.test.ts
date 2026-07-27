import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findProjectConfig, findProjectRoot } from "./project-root";

// Every test builds its own isolated directory tree under a fresh tmpdir —
// never reused across tests, and never anywhere near the real repo's own
// .git/package.json — so the boundary-stop behavior is exercised
// deterministically instead of depending on where this file happens to sit
// in the real chant checkout.
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chant-project-root-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findProjectConfig / findProjectRoot (chant #1117)", () => {
  test("found at root — chant.config.ts in the start dir itself", () => {
    writeFileSync(join(root, "chant.config.ts"), "export default {};");

    const result = findProjectConfig(root);

    expect(result.dir).toBe(root);
    expect(result.configPath).toBe(join(root, "chant.config.ts"));
    expect(findProjectRoot(root)).toBe(root);
  });

  test("found at an intermediate ancestor — several levels below the config", () => {
    writeFileSync(join(root, "chant.config.json"), "{}");
    const stackDir = join(root, "src", "stacks", "shared-foundation");
    mkdirSync(stackDir, { recursive: true });

    const result = findProjectConfig(stackDir);

    expect(result.dir).toBe(root);
    expect(result.configPath).toBe(join(root, "chant.config.json"));
    expect(findProjectRoot(stackDir)).toBe(root);
  });

  test("not found — no chant.config, no .git, no package.json anywhere above start dir: falls back to start dir, not the filesystem root", () => {
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });

    const result = findProjectConfig(deep);

    // Nothing between `deep` and the real filesystem root declares a chant
    // config or a boundary marker (this mkdtemp tree carries none). Rather
    // than adopting "/" as the project root — which would make a downstream
    // caller that scopes a directory walk off this result (e.g.
    // `resolveProjectLexicons` -> `findInfraFiles`) scan the entire disk —
    // the walk gives up and returns `deep` itself unchanged.
    expect(result.configPath).toBeUndefined();
    expect(result.dir).toBe(deep);
    expect(findProjectRoot(deep)).toBe(deep);
  });

  test("boundary stop — a .git/package.json ancestor halts the walk before an outer chant.config.ts", () => {
    // An unrelated chant.config.ts two levels above this project's own git
    // root must never be picked up — the boundary marker (.git here) stops
    // the walk at the project's own root first.
    writeFileSync(join(root, "chant.config.ts"), "export default { unrelated: true };");
    const projectRoot = join(root, "project");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    const stackDir = join(projectRoot, "src", "stack");
    mkdirSync(stackDir, { recursive: true });

    const result = findProjectConfig(stackDir);

    expect(result.dir).toBe(projectRoot);
    expect(result.configPath).toBeUndefined();
    expect(findProjectRoot(stackDir)).toBe(projectRoot);
  });

  test("boundary stop — package.json (no .git) halts the walk the same way", () => {
    writeFileSync(join(root, "chant.config.json"), "{}");
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "package.json"), "{}");
    const stackDir = join(projectRoot, "src", "stack");
    mkdirSync(stackDir, { recursive: true });

    const result = findProjectConfig(stackDir);

    expect(result.dir).toBe(projectRoot);
    expect(result.configPath).toBeUndefined();
  });

  test("a config living exactly at the boundary dir is still found — boundary check never wins over a real config", () => {
    const projectRoot = join(root, "project");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    writeFileSync(join(projectRoot, "chant.config.ts"), "export default {};");
    const stackDir = join(projectRoot, "src", "stack");
    mkdirSync(stackDir, { recursive: true });

    const result = findProjectConfig(stackDir);

    expect(result.dir).toBe(projectRoot);
    expect(result.configPath).toBe(join(projectRoot, "chant.config.ts"));
  });
});
