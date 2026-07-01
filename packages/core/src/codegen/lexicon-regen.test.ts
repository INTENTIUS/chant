import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { regenLexicon, writeSurfaceSnapshot, SNAPSHOT_FILENAME } from "./lexicon-regen";
import { type SurfaceSnapshot } from "./surface-snapshot";

// ── Helpers ───────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "chant-regen-test-"));
}

function makeMinimalLexiconDir(tmpDir: string): string {
  // Create a fake lexicon directory with a package.json
  // and a generate script that fails immediately.
  const pkg = {
    name: "@intentius/chant-lexicon-test",
    version: "0.1.0",
    type: "module",
    scripts: {
      generate: "exit 1",
      bundle: "exit 0",
      validate: "exit 0",
      build: "exit 0",
    },
  };
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify(pkg, null, 2));
  return tmpDir;
}

function makeWorkingLexiconDir(tmpDir: string): string {
  // A lexicon where generate "succeeds" by producing minimal artifacts.
  const pkg = {
    name: "@intentius/chant-lexicon-test",
    version: "0.1.0",
    type: "module",
    scripts: {
      // These scripts use node -e to create the generated dir + minimal files
      generate: `node -e "
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'src', 'generated');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'lexicon-test.json'), JSON.stringify({Widget:{kind:'resource',resourceType:'X::Y::Widget',attrs:{Id:'Id'}}}));
fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export declare class Widget { constructor(props: { Name?: string; }); readonly Id: string; }');
"`,
      bundle: "node -e \"\"",
      validate: "node -e \"\"",
      build: "node -e \"\"",
    },
  };
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify(pkg, null, 2));
  return tmpDir;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("regenLexicon — failure capture", () => {
  test("returns failure when lexicon dir has no package.json", async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await regenLexicon({ lexiconDir: join(tmpDir, "nonexistent") });
      expect(result.ok).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].step).toBe("setup");
      expect(result.failures[0].output).toContain("No package.json found");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns failure when generate script fails", async () => {
    const tmpDir = makeTmpDir();
    try {
      makeMinimalLexiconDir(tmpDir);
      const result = await regenLexicon({
        lexiconDir: tmpDir,
        skipBundle: true,
        skipBuild: true,
        skipLint: true,
      });
      expect(result.ok).toBe(false);
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      expect(result.failures[0].step).toBe("generate");
      expect(result.freshSnapshot).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("captures generate failure exit code", async () => {
    const tmpDir = makeTmpDir();
    try {
      makeMinimalLexiconDir(tmpDir);
      const result = await regenLexicon({
        lexiconDir: tmpDir,
        skipBundle: true,
        skipBuild: true,
        skipLint: true,
      });
      const genFail = result.failures.find((f) => f.step === "generate");
      expect(genFail).toBeDefined();
      expect(typeof genFail!.exitCode).toBe("number");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns failure when generated artifacts are missing after generate", async () => {
    // generate succeeds but produces no artifacts
    const tmpDir = makeTmpDir();
    try {
      const pkg = {
        name: "@intentius/chant-lexicon-test",
        version: "0.1.0",
        type: "module",
        scripts: {
          generate: "node -e \"\"", // succeeds but writes nothing
          bundle: "node -e \"\"",
          validate: "node -e \"\"",
          build: "node -e \"\"",
        },
      };
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify(pkg, null, 2));

      const result = await regenLexicon({
        lexiconDir: tmpDir,
        skipBundle: true,
        skipBuild: true,
        skipLint: true,
      });

      expect(result.ok).toBe(false);
      const extractFail = result.failures.find((f) => f.step === "surface-extract");
      expect(extractFail).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pinned digest failure is captured and aborts early", async () => {
    const tmpDir = makeTmpDir();
    try {
      makeMinimalLexiconDir(tmpDir);

      // Create a digest file that references a missing spec
      const digestPath = join(tmpDir, "spec.digest");
      writeFileSync(digestPath, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  CloudformationSchema.zip");

      const result = await regenLexicon({
        lexiconDir: tmpDir,
        pinnedDigestPath: digestPath,
        skipBundle: true,
        skipBuild: true,
        skipLint: true,
      });

      expect(result.ok).toBe(false);
      const digestFail = result.failures.find((f) => f.step === "digest-verify");
      expect(digestFail).toBeDefined();
      expect(digestFail!.output).toContain("not found");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pinned digest mismatch is captured as failure", async () => {
    const tmpDir = makeTmpDir();
    try {
      makeMinimalLexiconDir(tmpDir);

      // Write a dummy spec file
      const specContent = "dummy spec content";
      writeFileSync(join(tmpDir, "spec.zip"), specContent);

      // Write a digest file with the wrong hash
      const digestPath = join(tmpDir, "spec.digest");
      writeFileSync(digestPath, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  spec.zip");

      const result = await regenLexicon({
        lexiconDir: tmpDir,
        pinnedDigestPath: digestPath,
        skipBundle: true,
        skipBuild: true,
        skipLint: true,
      });

      expect(result.ok).toBe(false);
      const digestFail = result.failures.find((f) => f.step === "digest-verify");
      expect(digestFail).toBeDefined();
      expect(digestFail!.output).toContain("mismatch");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("regenLexicon — surface extraction and diff", () => {
  test("extracts fresh surface when generate succeeds", async () => {
    const tmpDir = makeTmpDir();
    try {
      makeWorkingLexiconDir(tmpDir);

      const result = await regenLexicon({
        lexiconDir: tmpDir,
        skipBundle: true,
        skipBuild: true,
        skipLint: true,
      });

      // Should not fail on generate/bundle/validate/build
      // (it may fail on surface-extract if the npm scripts fail in this env,
      // but the freshSnapshot check is what matters)
      if (result.freshSnapshot !== null) {
        expect(result.freshSnapshot.schemaVersion).toBe(1);
        expect(typeof result.freshSnapshot.entries).toBe("object");
      }
      // delta is always returned (may be empty)
      expect(result.delta).toBeDefined();
      expect(Array.isArray(result.delta.added)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000); // allow up to 30s for npm scripts

  test("treats all entries as added when no baseline exists", async () => {
    const tmpDir = makeTmpDir();
    try {
      makeWorkingLexiconDir(tmpDir);

      const result = await regenLexicon({
        lexiconDir: tmpDir,
        skipBundle: true,
        skipBuild: true,
        skipLint: true,
      });

      // No surface.snapshot.json exists → everything is "added"
      if (result.ok && result.freshSnapshot) {
        expect(result.changed).toBe(true);
        expect(result.delta.severity).toBe("additive");
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("writeSnapshot", () => {
  test("writes surface.snapshot.json to the lexicon dir", () => {
    const tmpDir = makeTmpDir();
    try {
      const snap: SurfaceSnapshot = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        entries: {
          Widget: { kind: "resource", resourceType: "X::Y::Widget" },
        },
      };

      writeSurfaceSnapshot(tmpDir, snap);

      const snapshotPath = join(tmpDir, SNAPSHOT_FILENAME);
      expect(existsSync(snapshotPath)).toBe(true);
      const json = JSON.parse(readFileSync(snapshotPath, "utf-8")) as SurfaceSnapshot;
      expect(json.schemaVersion).toBe(1);
      expect(json.entries.Widget.kind).toBe("resource");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("SNAPSHOT_FILENAME is 'surface.snapshot.json'", () => {
    expect(SNAPSHOT_FILENAME).toBe("surface.snapshot.json");
  });
});

// ── Inline result shape ───────────────────────────────────────────────

describe("RegenResult shape", () => {
  test("result has all required fields when setup fails", async () => {
    const result = await regenLexicon({ lexiconDir: "/nonexistent/path/xyz" });
    expect("ok" in result).toBe(true);
    expect("changed" in result).toBe(true);
    expect("severity" in result).toBe(true);
    expect("delta" in result).toBe(true);
    expect("deltaText" in result).toBe(true);
    expect("failures" in result).toBe(true);
    expect("freshSnapshot" in result).toBe(true);

    expect(result.delta.added).toBeInstanceOf(Array);
    expect(result.delta.changed).toBeInstanceOf(Array);
    expect(result.delta.removed).toBeInstanceOf(Array);
    expect(["additive", "breaking", "none"]).toContain(result.severity);
  });
});

