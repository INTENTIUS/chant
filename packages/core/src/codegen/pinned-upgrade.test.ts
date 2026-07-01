import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseVersion,
  compareVersionTuples,
  isNewer,
  isPreRelease,
  readPinnedVersion,
  applyVersionBump,
  revertVersionBump,
  checkPinnedUpgrade,
  type LexiconId,
} from "./pinned-upgrade";

// ── Version parsing / comparison ──────────────────────────────────────

describe("parseVersion", () => {
  test("strips leading v", () => {
    expect(parseVersion("v1.32.0")).toEqual([1, 32, 0]);
  });

  test("strips build-metadata suffix", () => {
    expect(parseVersion("v17.8.1-ee")).toEqual([17, 8, 1]);
  });

  test("handles versions without v prefix", () => {
    expect(parseVersion("27.3.1")).toEqual([27, 3, 1]);
  });

  test("returns null for non-numeric", () => {
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("v1.x.0")).toBeNull();
  });
});

describe("compareVersionTuples", () => {
  test("orders by major, minor, patch", () => {
    expect(compareVersionTuples([1, 33, 0], [1, 32, 0])).toBe(1);
    expect(compareVersionTuples([1, 32, 0], [1, 33, 0])).toBe(-1);
    expect(compareVersionTuples([1, 32, 0], [1, 32, 0])).toBe(0);
  });

  test("treats missing segments as zero", () => {
    expect(compareVersionTuples([1, 32], [1, 32, 0])).toBe(0);
    expect(compareVersionTuples([2], [1, 99, 99])).toBe(1);
  });
});

describe("isNewer", () => {
  test("true when candidate is strictly newer", () => {
    expect(isNewer("v1.33.0", "v1.32.0")).toBe(true);
    expect(isNewer("v1.32.1", "v1.32.0")).toBe(true);
  });

  test("false when equal or older", () => {
    expect(isNewer("v1.32.0", "v1.32.0")).toBe(false);
    expect(isNewer("v1.31.0", "v1.32.0")).toBe(false);
  });

  test("compares numeric part ignoring -ee suffix", () => {
    expect(isNewer("v17.9.0-ee", "v17.8.1-ee")).toBe(true);
    expect(isNewer("v17.8.1-ee", "v17.8.1-ee")).toBe(false);
  });

  test("false on unparseable input", () => {
    expect(isNewer("main", "v1.32.0")).toBe(false);
    expect(isNewer("v1.33.0", "main")).toBe(false);
  });
});

describe("isPreRelease", () => {
  test("detects rc/alpha/beta/preview", () => {
    expect(isPreRelease("v1.33.0-rc.1")).toBe(true);
    expect(isPreRelease("v1.33.0-alpha.0")).toBe(true);
    expect(isPreRelease("v1.33.0-beta2")).toBe(true);
    expect(isPreRelease("v1.33.0-preview")).toBe(true);
  });

  test("stable releases are not pre-release", () => {
    expect(isPreRelease("v1.33.0")).toBe(false);
    expect(isPreRelease("v17.8.1-ee")).toBe(false);
  });
});

// ── Pin read / bump / revert ──────────────────────────────────────────

interface PinFixture {
  filePath: string;
  pattern: RegExp;
  buildReplacement: (newV: string, oldV: string, line: string) => string;
}

function k8sPin(dir: string): PinFixture {
  return {
    filePath: join(dir, "fetch.ts"),
    pattern: /export const K8S_SCHEMA_VERSION\s*=\s*"([^"]+)"/,
    buildReplacement: (newVer, _old, line) =>
      line.replace(
        /export const K8S_SCHEMA_VERSION\s*=\s*"[^"]+"/,
        `export const K8S_SCHEMA_VERSION = "${newVer}"`,
      ),
  };
}

describe("readPinnedVersion / applyVersionBump / revertVersionBump", () => {
  test("round-trips a bump and revert", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pin-"));
    try {
      const file = join(dir, "fetch.ts");
      const original = [
        "import { x } from 'y';",
        'export const K8S_SCHEMA_VERSION = "v1.32.0";',
        "function foo() {}",
      ].join("\n");
      writeFileSync(file, original);

      const pin = k8sPin(dir);

      expect(readPinnedVersion(pin)).toBe("v1.32.0");

      const saved = applyVersionBump(pin, "v1.33.0");
      expect(saved).toBe(original);
      expect(readPinnedVersion(pin)).toBe("v1.33.0");
      // Only the constant line changed
      expect(readFileSync(file, "utf-8")).toContain('export const K8S_SCHEMA_VERSION = "v1.33.0";');
      expect(readFileSync(file, "utf-8")).toContain("function foo() {}");

      revertVersionBump(file, saved);
      expect(readPinnedVersion(pin)).toBe("v1.32.0");
      expect(readFileSync(file, "utf-8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readPinnedVersion returns null when pattern absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pin-"));
    try {
      const file = join(dir, "fetch.ts");
      writeFileSync(file, "export const OTHER = 1;\n");
      expect(readPinnedVersion(k8sPin(dir))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── checkPinnedUpgrade with mocked upstream ───────────────────────────

/**
 * Build a minimal lexicon dir whose scripts produce generated artifacts so
 * regenLexicon has something to surface-diff. Used only when we expect a bump
 * to occur (so regen actually runs).
 */
function makeWorkingLexicon(
  root: string,
  lexicon: LexiconId,
  pinFileRel: string,
  pinFileContent: string,
): string {
  const dir = mkdtempSync(join(root, `chant-lex-${lexicon}-`));
  const pkg = {
    name: `@intentius/chant-lexicon-${lexicon}`,
    version: "0.1.0",
    type: "module",
    scripts: {
      generate: `node -e "const fs=require('fs');const p=require('path');const d=p.join(__dirname,'src','generated');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'lexicon-${lexicon}.json'),JSON.stringify({Widget:{kind:'resource',resourceType:'X::Y::Widget',attrs:{Id:'Id'}}}));fs.writeFileSync(p.join(d,'index.d.ts'),'export declare class Widget { constructor(props: { Name?: string; }); readonly Id: string; }');"`,
      bundle: 'node -e ""',
      validate: 'node -e ""',
      build: 'node -e ""',
    },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  // Write the pin file at the expected relative path
  const pinPath = join(dir, pinFileRel);
  mkdirSync(join(pinPath, ".."), { recursive: true });
  writeFileSync(pinPath, pinFileContent);
  return dir;
}

describe("checkPinnedUpgrade — no upgrade paths", () => {
  test("reports no upgrade when upstream equals pin", async () => {
    const root = mkdtempSync(join(tmpdir(), "chant-up-"));
    try {
      const dir = makeWorkingLexicon(
        root,
        "k8s",
        "src/spec/fetch.ts",
        'export const K8S_SCHEMA_VERSION = "v1.32.0";\n',
      );
      const result = await checkPinnedUpgrade({
        lexiconDir: dir,
        lexicon: "k8s",
        resolverOverride: async () => "v1.32.0",
      });
      expect(result.hasUpgrade).toBe(false);
      expect(result.from).toBe("v1.32.0");
      expect(result.to).toBe("v1.32.0");
      expect(result.validation).toBeNull();
      expect(result.fetchError).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports no upgrade when upstream is older", async () => {
    const root = mkdtempSync(join(tmpdir(), "chant-up-"));
    try {
      const dir = makeWorkingLexicon(
        root,
        "k8s",
        "src/spec/fetch.ts",
        'export const K8S_SCHEMA_VERSION = "v1.32.0";\n',
      );
      const result = await checkPinnedUpgrade({
        lexiconDir: dir,
        lexicon: "k8s",
        resolverOverride: async () => "v1.31.5",
      });
      expect(result.hasUpgrade).toBe(false);
      expect(result.validation).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("captures fetchError when the resolver throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "chant-up-"));
    try {
      const dir = makeWorkingLexicon(
        root,
        "gcp",
        "src/spec/fetch.ts",
        'export const KCC_VERSION = "v1.145.0";\n',
      );
      const result = await checkPinnedUpgrade({
        lexiconDir: dir,
        lexicon: "gcp",
        resolverOverride: async () => {
          throw new Error("network down");
        },
      });
      expect(result.hasUpgrade).toBe(false);
      expect(result.fetchError).toContain("network down");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports unknown pin when constant missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "chant-up-"));
    try {
      const dir = makeWorkingLexicon(
        root,
        "k8s",
        "src/spec/fetch.ts",
        "export const NOT_THE_PIN = 1;\n",
      );
      const result = await checkPinnedUpgrade({
        lexiconDir: dir,
        lexicon: "k8s",
        resolverOverride: async () => "v1.99.0",
      });
      expect(result.hasUpgrade).toBe(false);
      expect(result.from).toBe("(unknown)");
      expect(result.fetchError).toContain("Could not read pinned version constant");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkPinnedUpgrade — upgrade path (bump + regen + revert)", () => {
  test("bumps, regens, reverts and returns validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "chant-up-"));
    try {
      const pinContent = 'export const K8S_SCHEMA_VERSION = "v1.32.0";\n';
      const dir = makeWorkingLexicon(root, "k8s", "src/spec/fetch.ts", pinContent);
      const pinFile = join(dir, "src/spec/fetch.ts");

      const result = await checkPinnedUpgrade({
        lexiconDir: dir,
        lexicon: "k8s",
        resolverOverride: async () => "v1.33.0",
        skipBuild: true,
        skipBundle: true,
        skipLint: true,
      });

      expect(result.hasUpgrade).toBe(true);
      expect(result.from).toBe("v1.32.0");
      expect(result.to).toBe("v1.33.0");
      expect(result.validation).not.toBeNull();
      // regen produced a surface (no baseline → everything is "added")
      expect(result.validation?.freshSnapshot).not.toBeNull();

      // CRITICAL: the pin file must be reverted to the original content
      expect(readFileSync(pinFile, "utf-8")).toBe(pinContent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reverts the pin even when regen fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "chant-up-"));
    try {
      const pinContent = 'export const KCC_VERSION = "v1.145.0";\n';
      const dir = mkdtempSync(join(root, "chant-lex-gcp-"));
      // package.json whose generate fails → regen returns ok:false
      const pkg = {
        name: "@intentius/chant-lexicon-gcp",
        version: "0.1.0",
        type: "module",
        scripts: { generate: "exit 1", bundle: "exit 0", validate: "exit 0", build: "exit 0" },
      };
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      const pinFile = join(dir, "src/spec/fetch.ts");
      mkdirSync(join(dir, "src/spec"), { recursive: true });
      writeFileSync(pinFile, pinContent);

      const result = await checkPinnedUpgrade({
        lexiconDir: dir,
        lexicon: "gcp",
        resolverOverride: async () => "v1.146.0",
        skipBuild: true,
      });

      expect(result.hasUpgrade).toBe(true);
      expect(result.validation?.ok).toBe(false);
      // Pin reverted despite the failed regen
      expect(readFileSync(pinFile, "utf-8")).toBe(pinContent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("docker pin embedded in a URL bumps and reverts", async () => {
    const root = mkdtempSync(join(tmpdir(), "chant-up-"));
    try {
      const pinContent = [
        'export const ENGINE_API_URL =',
        '  "https://raw.githubusercontent.com/moby/moby/v27.3.1/api/swagger.yaml";',
        "",
      ].join("\n");
      const dir = makeWorkingLexicon(root, "docker", "src/codegen/versions.ts", pinContent);
      const pinFile = join(dir, "src/codegen/versions.ts");

      const result = await checkPinnedUpgrade({
        lexiconDir: dir,
        lexicon: "docker",
        resolverOverride: async () => "v28.0.0",
        skipBuild: true,
        skipBundle: true,
        skipLint: true,
      });

      expect(result.hasUpgrade).toBe(true);
      expect(result.from).toBe("v27.3.1");
      expect(result.to).toBe("v28.0.0");
      // reverted
      expect(readFileSync(pinFile, "utf-8")).toBe(pinContent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
