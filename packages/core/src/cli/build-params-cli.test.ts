/**
 * Tests for the CLI-layer build-time-parameter helpers factored out by chant
 * #1108 (`parseParamFlags`/`resolveCliBuildParams`) — the exact sequence
 * `chant build` (`./commands/build.ts`'s `buildCommand`) runs, now shared with
 * the component deploy driver (`./handlers/run.ts`, `./handlers/build.ts`'s
 * generate mode) so both resolve `--param`/`--params-file`/a declared `env`
 * mapping/`chant.config.ts`'s `buildParams` defaults identically. Precedence
 * itself is `../build-params.ts`'s `resolveBuildParams`'s responsibility
 * (see `../build-params.test.ts`) — these tests cover the CLI-specific glue:
 * flag parsing, `--params-file` reading, error formatting, and logging.
 */
import { describe, test, expect, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseParamFlags, resolveCliBuildParams } from "./build-params-cli";
import type { BuildParamsConfig } from "../build-params";

describe("parseParamFlags", () => {
  test("undefined/empty input yields undefined (matches resolveBuildParams's 'no cli input' shape)", () => {
    expect(parseParamFlags(undefined)).toBeUndefined();
    expect(parseParamFlags([])).toBeUndefined();
  });

  test("parses repeated name=value flags into a flat record", () => {
    expect(parseParamFlags(["tier=production", "replicas=3"])).toEqual({
      tier: "production",
      replicas: "3",
    });
  });

  test("a value containing '=' keeps everything after the first '=' (only the first splits)", () => {
    expect(parseParamFlags(["url=https://example.com?a=b"])).toEqual({
      url: "https://example.com?a=b",
    });
  });

  test("a flag with no '=' becomes an empty-string value", () => {
    expect(parseParamFlags(["flag-only"])).toEqual({ "flag-only": "" });
  });
});

describe("resolveCliBuildParams", () => {
  test("cli beats params-file beats a declared env mapping beats the default — the exact chant build precedence", () => {
    const defs: BuildParamsConfig = { tier: { type: "string", default: "light", env: "TIER_ENV" } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = resolveCliBuildParams(defs, { cli: { tier: "production" } });
      expect(result).toEqual({
        success: true,
        provenance: [{ name: "tier", value: "production", source: "cli" }],
        errors: [],
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("logs every resolved parameter as '[param] name = value (source)'", () => {
    const defs: BuildParamsConfig = { tier: { type: "string", default: "light" } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      resolveCliBuildParams(defs, {});
      const logged = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(logged.some((line) => line.includes("[param] tier") && line.includes("light") && line.includes("default"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("no declared params → success with empty provenance and no logging", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = resolveCliBuildParams(undefined, {});
      expect(result).toEqual({ success: true, provenance: [], errors: [] });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("an unresolved required parameter is a formatted error, not a thrown exception", () => {
    const defs: BuildParamsConfig = { tier: { type: "string" } };
    const result = resolveCliBuildParams(defs, {});
    expect(result.success).toBe(false);
    expect(result.provenance).toEqual([]);
    expect(result.errors.some((e) => e.includes('"tier"') && e.includes("--param"))).toBe(true);
  });

  test("an enum violation is a formatted error naming the parameter and the offending value", () => {
    const defs: BuildParamsConfig = { tier: { type: "string", enum: ["light", "production"] } };
    const result = resolveCliBuildParams(defs, { cli: { tier: "bogus" } });
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('"tier"') && e.includes("bogus"))).toBe(true);
  });

  test("an unknown --param name is a formatted error", () => {
    const defs: BuildParamsConfig = { tier: { type: "string", default: "light" } };
    const result = resolveCliBuildParams(defs, { cli: { nonexistent: "x" } });
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent") && e.includes("--param"))).toBe(true);
  });

  describe("--params-file", () => {
    let dir: string;

    test("reads and resolves values from a JSON file (second precedence, after --param)", () => {
      dir = mkdtempSync(join(tmpdir(), "chant-build-params-cli-test-"));
      try {
        const file = join(dir, "params.json");
        writeFileSync(file, JSON.stringify({ tier: "from-file", env: "from-file-env" }));
        const defs: BuildParamsConfig = {
          tier: { type: "string", default: "light" },
          env: { type: "string", default: "dev" },
        };

        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const result = resolveCliBuildParams(defs, { cli: { tier: "from-cli" }, paramsFile: file });
          expect(result.success).toBe(true);
          const byName = new Map(result.provenance.map((p) => [p.name, p]));
          expect(byName.get("tier")).toEqual({ name: "tier", value: "from-cli", source: "cli" });
          expect(byName.get("env")).toEqual({ name: "env", value: "from-file-env", source: "params-file" });
        } finally {
          errorSpy.mockRestore();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("an unreadable/unparsable --params-file is a formatted error naming the path, not a thrown exception", () => {
      const defs: BuildParamsConfig = { tier: { type: "string", default: "light" } };
      const result = resolveCliBuildParams(defs, { paramsFile: "/nonexistent/path/params.json" });
      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes("--params-file") && e.includes("/nonexistent/path/params.json"))).toBe(true);
    });
  });
});
