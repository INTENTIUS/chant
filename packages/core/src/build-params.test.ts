import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveBuildParams,
  buildParamValues,
  applyBuildParams,
  parseParamFlags,
  type BuildParamsConfig,
} from "./build-params";
import { params, setBuildParams } from "./params";

const TIER_DEF: BuildParamsConfig = {
  tier: { type: "string", default: "light", enum: ["light", "production", "production-ha"] },
};

describe("resolveBuildParams — precedence", () => {
  test("cli beats params-file beats env beats default", () => {
    const defs: BuildParamsConfig = { name: { type: "string", default: "d", env: "NAME_ENV" } };

    const cliOnly = resolveBuildParams(defs, { cli: { name: "from-cli" } });
    expect(cliOnly.errors).toEqual([]);
    expect(cliOnly.provenance).toEqual([{ name: "name", value: "from-cli", source: "cli" }]);

    const cliOverFile = resolveBuildParams(defs, { cli: { name: "from-cli" }, fromFile: { name: "from-file" } });
    expect(cliOverFile.provenance).toEqual([{ name: "name", value: "from-cli", source: "cli" }]);

    const fileOverEnv = resolveBuildParams(defs, { fromFile: { name: "from-file" }, env: { NAME_ENV: "from-env" } });
    expect(fileOverEnv.provenance).toEqual([{ name: "name", value: "from-file", source: "params-file" }]);

    const envOverDefault = resolveBuildParams(defs, { env: { NAME_ENV: "from-env" } });
    expect(envOverDefault.provenance).toEqual([{ name: "name", value: "from-env", source: "env" }]);

    const defaultOnly = resolveBuildParams(defs, {});
    expect(defaultOnly.provenance).toEqual([{ name: "name", value: "d", source: "default" }]);
  });

  test("a parameter with no env mapping ignores an unrelated env var of the same name", () => {
    const defs: BuildParamsConfig = { name: { type: "string", default: "d" } };
    const result = resolveBuildParams(defs, { env: { name: "should-not-be-used" } });
    expect(result.provenance).toEqual([{ name: "name", value: "d", source: "default" }]);
  });
});

describe("resolveBuildParams — validation", () => {
  test("missing value with no default is a build error naming the parameter", () => {
    const defs: BuildParamsConfig = { tier: { type: "string" } };
    const result = resolveBuildParams(defs, {});
    expect(result.provenance).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"tier"');
    expect(result.errors[0]).toContain("--param tier=");
  });

  test("enum violation names the parameter and the allowed values", () => {
    const result = resolveBuildParams(TIER_DEF, { cli: { tier: "bogus" } });
    expect(result.provenance).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"tier"');
    expect(result.errors[0]).toContain("light");
    expect(result.errors[0]).toContain("bogus");
  });

  test("enum success resolves normally", () => {
    const result = resolveBuildParams(TIER_DEF, { cli: { tier: "production" } });
    expect(result.errors).toEqual([]);
    expect(result.provenance).toEqual([{ name: "tier", value: "production", source: "cli" }]);
  });

  test("unknown --param key (not declared) is a build error", () => {
    const result = resolveBuildParams(TIER_DEF, { cli: { bogusName: "x" } });
    expect(result.errors.some((e) => e.includes('"bogusName"') && e.includes("--param"))).toBe(true);
  });

  test("unknown --params-file key (not declared) is a build error", () => {
    const result = resolveBuildParams(TIER_DEF, { fromFile: { bogusName: "x" } });
    expect(result.errors.some((e) => e.includes('"bogusName"') && e.includes("--params-file"))).toBe(true);
  });

  test("number type coercion, including a non-numeric failure", () => {
    const defs: BuildParamsConfig = { count: { type: "number" } };
    const ok = resolveBuildParams(defs, { cli: { count: "42" } });
    expect(ok.errors).toEqual([]);
    expect(ok.provenance).toEqual([{ name: "count", value: 42, source: "cli" }]);

    const bad = resolveBuildParams(defs, { cli: { count: "not-a-number" } });
    expect(bad.provenance).toEqual([]);
    expect(bad.errors[0]).toContain('"count"');
    expect(bad.errors[0]).toContain("number");
  });

  test("boolean type coercion, including an invalid string", () => {
    const defs: BuildParamsConfig = { flag: { type: "boolean" } };
    const trueVal = resolveBuildParams(defs, { cli: { flag: "true" } });
    expect(trueVal.provenance).toEqual([{ name: "flag", value: true, source: "cli" }]);

    const falseVal = resolveBuildParams(defs, { cli: { flag: "false" } });
    expect(falseVal.provenance).toEqual([{ name: "flag", value: false, source: "cli" }]);

    const bad = resolveBuildParams(defs, { cli: { flag: "nope" } });
    expect(bad.provenance).toEqual([]);
    expect(bad.errors[0]).toContain("boolean");
  });

  test("params-file value must be a scalar, not an object/array", () => {
    const defs: BuildParamsConfig = { thing: { type: "string" } };
    const result = resolveBuildParams(defs, { fromFile: { thing: { nested: true } as unknown as string } });
    expect(result.provenance).toEqual([]);
    expect(result.errors[0]).toContain('"thing"');
  });

  test("every failure across multiple parameters is reported at once", () => {
    const defs: BuildParamsConfig = {
      a: { type: "string" },
      b: { type: "number" },
    };
    const result = resolveBuildParams(defs, { cli: { b: "nan" } });
    expect(result.errors).toHaveLength(2);
  });

  test("no declared params at all — empty resolution, no errors", () => {
    const result = resolveBuildParams(undefined, {});
    expect(result).toEqual({ provenance: [], errors: [] });
  });

  test("required: false — an unresolved optional parameter is simply omitted, not an error", () => {
    const defs: BuildParamsConfig = { hostedZoneId: { type: "string", required: false } };
    const result = resolveBuildParams(defs, {});
    expect(result.errors).toEqual([]);
    expect(result.provenance).toEqual([]);
  });

  test("required: false — a supplied value still resolves normally", () => {
    const defs: BuildParamsConfig = { hostedZoneId: { type: "string", required: false } };
    const result = resolveBuildParams(defs, { cli: { hostedZoneId: "Z123" } });
    expect(result.errors).toEqual([]);
    expect(result.provenance).toEqual([{ name: "hostedZoneId", value: "Z123", source: "cli" }]);
  });
});

describe("buildParamValues", () => {
  test("projects provenance records down to a plain value map", () => {
    const provenance = [
      { name: "tier", value: "light" as const, source: "default" as const },
      { name: "count", value: 3 as const, source: "cli" as const },
    ];
    expect(buildParamValues(provenance)).toEqual({ tier: "light", count: 3 });
  });

  test("empty provenance yields an empty map", () => {
    expect(buildParamValues([])).toEqual({});
  });
});

describe("applyBuildParams (#1108)", () => {
  afterEach(() => {
    setBuildParams({});
  });

  test("binds resolved values to the shared params object", () => {
    const result = applyBuildParams(TIER_DEF, { cli: { tier: "production" } });
    expect(result.errors).toEqual([]);
    expect(params).toEqual({ tier: "production" });
  });

  test("on a resolution error, binds nothing — params keeps its previous contents", () => {
    setBuildParams({ tier: "light" });
    const result = applyBuildParams(TIER_DEF, { cli: { bogus: "x" } });
    expect(result.errors).toHaveLength(1);
    expect(params).toEqual({ tier: "light" });
  });

  test("reads and applies a params file by path", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-apply-params-"));
    try {
      const file = join(dir, "params.json");
      writeFileSync(file, JSON.stringify({ tier: "production-ha" }));
      const result = applyBuildParams(TIER_DEF, { paramsFilePath: file });
      expect(result.errors).toEqual([]);
      expect(params).toEqual({ tier: "production-ha" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable/unparseable params file is a returned error naming the path, and binds nothing", () => {
    setBuildParams({ tier: "light" });
    const result = applyBuildParams(TIER_DEF, { paramsFilePath: "/nonexistent/params.json" });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('/nonexistent/params.json');
    expect(params).toEqual({ tier: "light" });
  });

  test("a declared env mapping resolves from the supplied env", () => {
    const defs: BuildParamsConfig = { tier: { type: "string", default: "light", env: "CHANT_TEST_TIER" } };
    const result = applyBuildParams(defs, { env: { CHANT_TEST_TIER: "production" } });
    expect(result.errors).toEqual([]);
    expect(params).toEqual({ tier: "production" });
  });
});

describe("parseParamFlags (#1108)", () => {
  test("splits repeated name=value entries into a record", () => {
    expect(parseParamFlags(["tier=production", "replicas=3"])).toEqual({ tier: "production", replicas: "3" });
  });

  test("a value containing '=' splits on the first one only", () => {
    expect(parseParamFlags(["token=a=b"])).toEqual({ token: "a=b" });
  });

  test("a value-less entry maps to the empty string", () => {
    expect(parseParamFlags(["flag"])).toEqual({ flag: "" });
  });

  test("undefined or empty input yields undefined", () => {
    expect(parseParamFlags(undefined)).toBeUndefined();
    expect(parseParamFlags([])).toBeUndefined();
  });
});
