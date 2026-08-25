import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadChantConfig,
  loadChantConfigUpward,
  DEFAULT_CHANT_CONFIG,
  resolveAutoReleaseDisabled,
  resolveFoldEnabled,
  resolveSbomFormat,
  resolveKnowledgeDir,
  environmentName,
  environmentNames,
  environmentEndpoint,
  matchesEnvironmentPattern,
  matchesDeclaredEnvironment,
} from "./config";
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

// #1502 — the upward walk skips lint-scoping fragments. A `src/chant.config.json`
// holding only `extends`/`rules` (the examples/ convention) must not shadow the
// project config above it, or `chant build src` silently loses `ownership`/
// `buildParams` — the exact fallback #1117's walk exists to prevent.
describe("loadChantConfigUpward (#1502 — lint fragments do not end the walk)", () => {
  const SRC = join(TEST_DIR, "src");

  test("walks past a lint-only src/chant.config.json to the project config", async () => {
    mkdirSync(SRC, { recursive: true });
    writeFileSync(
      join(SRC, "chant.config.json"),
      JSON.stringify({ extends: ["@intentius/chant/lint/presets/strict"], rules: { COR001: "off" } }),
    );
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ ownership: { stack: "billing", env: "prod" } }),
    );

    const result = await loadChantConfigUpward(SRC);
    expect(result.config.ownership).toEqual({ stack: "billing", env: "prod" });
    expect(result.configPath).toBe(join(TEST_DIR, "chant.config.json"));
  });

  test("a src/chant.config.json declaring any project-level key still wins in place", async () => {
    mkdirSync(SRC, { recursive: true });
    writeFileSync(
      join(SRC, "chant.config.json"),
      JSON.stringify({ ownership: { stack: "nested" }, rules: { COR001: "off" } }),
    );
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ ownership: { stack: "root" } }),
    );

    const result = await loadChantConfigUpward(SRC);
    expect(result.config.ownership?.stack).toBe("nested");
  });

  // #1711 — JSON has no comments, so a project explaining its rule disables
  // reaches for an underscore key. Both CockroachDB examples carried
  // `_ruleNotes` in every stack's fragment, and that one key stopped the walk:
  // `chant build src/east` resolved the fragment, found no `buildParams`, and
  // emitted `...@undefined.iam.gserviceaccount.com` without a word.
  test("an underscore comment key does not turn a fragment into a project config", async () => {
    mkdirSync(SRC, { recursive: true });
    writeFileSync(
      join(SRC, "chant.config.json"),
      JSON.stringify({
        extends: ["@intentius/chant/lint/presets/strict"],
        _ruleNotes: { COR001: "inline objects read better here" },
        rules: { COR001: "off" },
      }),
    );
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({
        ownership: { stack: "crdb-multi-region" },
        buildParams: { projectId: { type: "string", default: "my-project" } },
      }),
    );

    const result = await loadChantConfigUpward(SRC);
    expect(result.config.ownership?.stack).toBe("crdb-multi-region");
    expect(result.config.buildParams?.projectId?.default).toBe("my-project");
    expect(result.configPath).toBe(join(TEST_DIR, "chant.config.json"));
  });

  test("a non-comment unknown key still stops the walk, but says so", async () => {
    mkdirSync(SRC, { recursive: true });
    writeFileSync(
      join(SRC, "chant.config.json"),
      JSON.stringify({ extends: ["@intentius/chant/lint/presets/strict"], ruleNotes: { a: "b" } }),
    );
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ ownership: { stack: "root" } }),
    );

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await loadChantConfigUpward(SRC);
      // Unchanged behaviour: the fragment is the project config. What is new is
      // that the build no longer loses the root config in silence.
      expect(result.configPath).toBe(join(SRC, "chant.config.json"));
      expect(result.config.ownership).toBeUndefined();
      const said = warn.mock.calls.flat().join("\n");
      expect(said).toContain("declares no project-level key");
      expect(said).toContain('"ruleNotes"');
    } finally {
      warn.mockRestore();
    }
  });

  test("a fragment-only project resolves to the default config at the boundary", async () => {
    mkdirSync(SRC, { recursive: true });
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({ name: "boundary" }));
    writeFileSync(
      join(SRC, "chant.config.json"),
      JSON.stringify({ extends: ["@intentius/chant/lint/presets/strict"] }),
    );

    const result = await loadChantConfigUpward(SRC);
    expect(result.config).toEqual(DEFAULT_CHANT_CONFIG);
    expect(result.configPath).toBeUndefined();
  });
});

// #1166 — `environments` accepts either a bare name (unchanged) or
// `{ name, endpoint }`, so a declared environment can be self-sufficient for
// `--live` reads without an ambient AWS_ENDPOINT_URL export.
describe("environments (#1166 — string or { name, endpoint })", () => {
  test("bare string environments load exactly as before", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ environments: ["dev", "prod"] }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.environments).toEqual(["dev", "prod"]);
  });

  test("an object entry with a declared endpoint loads alongside bare strings", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({
        environments: ["prod", { name: "floci", endpoint: "http://localhost:4566" }],
      }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.environments).toEqual([
      "prod",
      { name: "floci", endpoint: "http://localhost:4566" },
    ]);
  });

  test("an object entry with no endpoint is legal (name-only, same as a bare string)", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ environments: [{ name: "staging" }] }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.environments).toEqual([{ name: "staging" }]);
  });

  test("rejects an environments entry that is neither a string nor { name }", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ environments: [{ endpoint: "http://localhost:4566" }] }),
    );

    await expect(loadChantConfig(TEST_DIR)).rejects.toThrow(/environments/);
  });
});

describe("vulnPolicy exploitability fields (#1466)", () => {
  test("loads the exploitability fields, zero thresholds included", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ vulnPolicy: { failOnKev: true, failEpssAtOrAbove: 0, warnEpssAtOrAbove: 0.01, exploitabilityFixableOnly: false } }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.vulnPolicy).toEqual({ failOnKev: true, failEpssAtOrAbove: 0, warnEpssAtOrAbove: 0.01, exploitabilityFixableOnly: false });
  });

  test("rejects an EPSS threshold outside 0.0–1.0", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ vulnPolicy: { failEpssAtOrAbove: 1.5 } }),
    );

    await expect(loadChantConfig(TEST_DIR)).rejects.toThrow(/failEpssAtOrAbove/);
  });
});

describe("environmentName / environmentNames / environmentEndpoint (#1166)", () => {
  test("environmentName reduces either form to its name", () => {
    expect(environmentName("prod")).toBe("prod");
    expect(environmentName({ name: "floci", endpoint: "http://localhost:4566" })).toBe("floci");
    expect(environmentName({ name: "staging" })).toBe("staging");
  });

  test("environmentNames maps a mixed list, and passes undefined through", () => {
    expect(environmentNames(["prod", { name: "floci", endpoint: "http://x" }])).toEqual(["prod", "floci"]);
    expect(environmentNames(undefined)).toBeUndefined();
    expect(environmentNames([])).toEqual([]);
  });

  test("environmentEndpoint resolves the declared endpoint, or undefined otherwise", () => {
    const environments = ["prod", { name: "floci", endpoint: "http://localhost:4566" }, { name: "staging" }];
    expect(environmentEndpoint(environments, "floci")).toBe("http://localhost:4566");
    expect(environmentEndpoint(environments, "prod")).toBeUndefined(); // bare string, no endpoint
    expect(environmentEndpoint(environments, "staging")).toBeUndefined(); // object, but no endpoint set
    expect(environmentEndpoint(environments, "unknown")).toBeUndefined(); // not declared at all
    expect(environmentEndpoint(undefined, "floci")).toBeUndefined();
  });

  test("environmentEndpoint resolves through a pattern entry, literal entry winning (#1221)", () => {
    const environments = [
      { name: "pr-special", endpoint: "http://special:1111" },
      { name: "pr-*", endpoint: "http://preview:4566" },
    ];
    expect(environmentEndpoint(environments, "pr-42")).toBe("http://preview:4566");
    expect(environmentEndpoint(environments, "pr-special")).toBe("http://special:1111"); // literal wins over the pattern
    expect(environmentEndpoint(environments, "prod")).toBeUndefined();
  });
});

describe("environment glob patterns (#1221)", () => {
  test("matchesEnvironmentPattern: a * matches any run of characters, anchored", () => {
    expect(matchesEnvironmentPattern("pr-*", "pr-42")).toBe(true);
    expect(matchesEnvironmentPattern("pr-*", "pr-")).toBe(true); // empty run is a run
    expect(matchesEnvironmentPattern("pr-*", "pr")).toBe(false);
    expect(matchesEnvironmentPattern("pr-*", "xpr-42")).toBe(false); // anchored at the start
    expect(matchesEnvironmentPattern("*-preview", "42-preview")).toBe(true);
    expect(matchesEnvironmentPattern("*-preview", "42-preview-old")).toBe(false); // anchored at the end
    expect(matchesEnvironmentPattern("test-*-eu", "test-a-eu")).toBe(true);
    expect(matchesEnvironmentPattern("test-*-eu", "test-a-us")).toBe(false);
  });

  test("matchesEnvironmentPattern without a * is plain equality", () => {
    expect(matchesEnvironmentPattern("prod", "prod")).toBe(true);
    expect(matchesEnvironmentPattern("prod", "prod2")).toBe(false);
  });

  test("matchesDeclaredEnvironment: literal first, then pattern, across entry forms", () => {
    const environments = ["dev", "prod", "pr-*", { name: "test-*", endpoint: "http://localhost:4566" }];
    expect(matchesDeclaredEnvironment(environments, "prod")).toBe(true);
    expect(matchesDeclaredEnvironment(environments, "pr-42")).toBe(true);
    expect(matchesDeclaredEnvironment(environments, "test-suite-a")).toBe(true); // object-form pattern entry
    expect(matchesDeclaredEnvironment(environments, "stage")).toBe(false);
    expect(matchesDeclaredEnvironment(undefined, "prod")).toBe(false);
    expect(matchesDeclaredEnvironment([], "prod")).toBe(false);
  });
});

describe("resolveFoldEnabled (#1134 — fold is the default build path)", () => {
  test("default (no flag, no config) → fold ON", () => {
    expect(resolveFoldEnabled({})).toBe(true);
  });

  test("config build.fold: false turns it off; true keeps it on", () => {
    expect(resolveFoldEnabled({ build: { fold: false } })).toBe(false);
    expect(resolveFoldEnabled({ build: { fold: true } })).toBe(true);
    expect(resolveFoldEnabled({ build: {} })).toBe(true);
  });

  test("--fold (flag true) beats config false", () => {
    expect(resolveFoldEnabled({ build: { fold: false } }, true)).toBe(true);
  });

  test("--no-fold (flag false) beats config true and the default", () => {
    expect(resolveFoldEnabled({ build: { fold: true } }, false)).toBe(false);
    expect(resolveFoldEnabled({}, false)).toBe(false);
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

describe("resolveKnowledgeDir (#1864, design #1059)", () => {
  test("convention: knowledge/ beside the project root when config is silent", () => {
    expect(resolveKnowledgeDir({}, "/proj")).toBe(join("/proj", "knowledge"));
  });

  test("config override honored", () => {
    expect(resolveKnowledgeDir({ knowledge: { dir: "docs/knowledge" } }, "/proj")).toBe(join("/proj", "docs/knowledge"));
  });

  test("an empty knowledge object still falls back to the convention name", () => {
    expect(resolveKnowledgeDir({ knowledge: {} }, "/proj")).toBe(join("/proj", "knowledge"));
  });
});
