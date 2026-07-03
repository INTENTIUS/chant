import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { loadChantConfig, DEFAULT_CHANT_CONFIG, resolveAutoReleaseDisabled, resolveSbomFormat } from "./config";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dirname, "__test_chant_config__");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadChantConfig", () => {
  test("returns default config when no config file exists", async () => {
    const result = await loadChantConfig(TEST_DIR);
    expect(result.config).toEqual(DEFAULT_CHANT_CONFIG);
    expect(result.configPath).toBeUndefined();
  });

  test("loads chant.config.ts with default export", async () => {
    const tsPath = join(TEST_DIR, "chant.config.ts");
    writeFileSync(
      tsPath,
      `export default { lexicons: ["testdom"], lint: { rules: { COR001: "error" } } };`,
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.lexicons).toEqual(["testdom"]);
    expect(result.config.lint?.rules?.COR001).toBe("error");
    expect(result.configPath).toBe(tsPath);
  });

  test("loads chant.config.ts with named config export", async () => {
    const tsPath = join(TEST_DIR, "chant.config.ts");
    writeFileSync(
      tsPath,
      `export const config = { lexicons: ["testdom"] };`,
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.lexicons).toEqual(["testdom"]);
  });

  test("loads chant.config.json", async () => {
    const jsonPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({ lexicons: ["testdom"] }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.lexicons).toEqual(["testdom"]);
    expect(result.configPath).toBe(jsonPath);
  });

  // #559, epic #551: `capabilities` mirrors `lexicons` — additional
  // capability plugin package names loaded on top of the built-in starter
  // set (see ./components/capability-plugin-loader.ts's `buildCapabilityRegistry`).
  test("loads chant.config.json with capabilities", async () => {
    const jsonPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({ lexicons: ["aws"], capabilities: ["acme"] }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.capabilities).toEqual(["acme"]);
  });

  test("prefers .ts over .json when both exist", async () => {
    // .ts takes priority — verify by checking configPath ends with .ts
    writeFileSync(
      join(TEST_DIR, "chant.config.ts"),
      `export default { lexicons: ["testdom"] };`,
    );
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ lexicons: ["from-json"] }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.configPath?.endsWith("chant.config.ts")).toBe(true);
  });

  test("handles empty config", async () => {
    writeFileSync(join(TEST_DIR, "chant.config.json"), "{}");

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config).toEqual({});
  });

  test("handles config with only lexicons", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ lexicons: ["testdom"] }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.lexicons).toEqual(["testdom"]);
    expect(result.config.lint).toBeUndefined();
  });

  // #597: release.autoRecord opts out of auto-emitting a release-ledger
  // record from `chant run --components` post-run.
  test("loads chant.config.json with release.autoRecord: false", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ release: { autoRecord: false } }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.release?.autoRecord).toBe(false);
  });

  // #606: sbom.format sets the project-wide default SBOM format for every
  // `generate-sbom` step that doesn't specify its own.
  test("loads chant.config.json with sbom.format: cyclonedx", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ sbom: { format: "cyclonedx" } }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.sbom?.format).toBe("cyclonedx");
  });
});

describe("resolveAutoReleaseDisabled", () => {
  test("default (no flag, no config) → not disabled", () => {
    expect(resolveAutoReleaseDisabled({})).toBe(false);
  });

  test("the CLI flag disables regardless of config", () => {
    expect(resolveAutoReleaseDisabled({}, true)).toBe(true);
    expect(resolveAutoReleaseDisabled({ release: { autoRecord: true } }, true)).toBe(true);
  });

  test("release.autoRecord: false disables without the CLI flag", () => {
    expect(resolveAutoReleaseDisabled({ release: { autoRecord: false } })).toBe(true);
  });

  test("release.autoRecord: true (or unset) does not disable", () => {
    expect(resolveAutoReleaseDisabled({ release: { autoRecord: true } })).toBe(false);
    expect(resolveAutoReleaseDisabled({ release: {} })).toBe(false);
  });
});

describe("resolveSbomFormat (#606)", () => {
  test("defaults to spdx (DEFAULT_SBOM_FORMAT) with no config and no step override", () => {
    expect(resolveSbomFormat({})).toBe("spdx");
  });

  test("project config sbom.format overrides the built-in default", () => {
    expect(resolveSbomFormat({ sbom: { format: "cyclonedx" } })).toBe("cyclonedx");
  });

  test("a step-level format always wins over project config", () => {
    expect(resolveSbomFormat({ sbom: { format: "cyclonedx" } }, "spdx")).toBe("spdx");
    expect(resolveSbomFormat({}, "cyclonedx")).toBe("cyclonedx");
  });
});
