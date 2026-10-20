import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyPatches, KNOWN_STALE_PATCHES, typeNameToPatchDir, type StalePatch } from "./patches";
import { PINNED_VERSIONS } from "./versions";

const MEDIALIVE = "AWS::MediaLive::InputSecurityGroup";

// The patch cfn-lint v1.32.4 ships for MediaLive, verbatim.
const MEDIALIVE_FORMAT_PATCH = [
  { op: "add", path: "/definitions/InputWhitelistRuleCidr/properties/Cidr/format", value: "ipv4-network" },
];

// The shape the 2026-10-19 spec gives the definition, trimmed.
const medialiveSchema = (definition: string) =>
  Buffer.from(
    JSON.stringify({
      typeName: MEDIALIVE,
      definitions: { [definition]: { type: "object", properties: { Cidr: { type: "string" } } } },
      properties: {},
    }),
  );

let dir: string;

const writePatch = (typeName: string, file: string, ops: unknown) => {
  const d = join(dir, typeNameToPatchDir(typeName));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), JSON.stringify(ops));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfn-lint-patches-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("applyPatches known-stale tracking", () => {
  test("the MediaLive patch against the renamed definition is a skip, not a warning", () => {
    writePatch(MEDIALIVE, "format.json", MEDIALIVE_FORMAT_PATCH);
    const schemas = new Map([[MEDIALIVE, medialiveSchema("InputWhitelistRule")]]);

    const { stats } = applyPatches(schemas, dir);

    expect(stats.patchesApplied).toBe(0);
    expect(stats.warnings).toEqual([]);
    expect(stats.skipped.map((s) => `${s.stale.typeName}/${s.stale.patchFile}`)).toEqual([`${MEDIALIVE}/format.json`]);
    expect(stats.skipped[0].error.message).toContain("InputWhitelistRuleCidr");
    expect(stats.retirable).toEqual([]);
  });

  test("a failure not on the list stays a warning", () => {
    writePatch(MEDIALIVE, "format.json", MEDIALIVE_FORMAT_PATCH);
    const schemas = new Map([[MEDIALIVE, medialiveSchema("InputWhitelistRule")]]);

    const { stats } = applyPatches(schemas, dir, []);

    expect(stats.skipped).toEqual([]);
    expect(stats.warnings.map((w) => `${w.typeName}/${w.patchFile}`)).toEqual([`${MEDIALIVE}/format.json`]);
  });

  test("an entry whose patch applies again is retirable", () => {
    writePatch(MEDIALIVE, "format.json", MEDIALIVE_FORMAT_PATCH);
    const schemas = new Map([[MEDIALIVE, medialiveSchema("InputWhitelistRuleCidr")]]);

    const { schemas: patched, stats } = applyPatches(schemas, dir);

    expect(stats.patchesApplied).toBe(1);
    expect(stats.skipped).toEqual([]);
    expect(stats.retirable.map((s) => s.typeName)).toEqual([MEDIALIVE]);
    const doc = JSON.parse(patched.get(MEDIALIVE)!.toString("utf-8"));
    expect(doc.definitions.InputWhitelistRuleCidr.properties.Cidr.format).toBe("ipv4-network");
  });

  test("an entry with no patch file to fail is retirable", () => {
    const stale: StalePatch = { typeName: "AWS::Test::Gone", patchFile: "manual.json", cfnLint: "v0", reason: "test" };
    const { stats } = applyPatches(new Map(), dir, [stale]);
    expect(stats.retirable).toEqual([stale]);
  });
});

describe("KNOWN_STALE_PATCHES", () => {
  // Moving the cfn-lint pin changes which patches fail, so every entry has to
  // be re-checked against the new release before this passes again.
  test("every entry was checked against the pinned cfn-lint release", () => {
    for (const s of KNOWN_STALE_PATCHES) expect(s.cfnLint).toBe(PINNED_VERSIONS.cfnLint);
  });

  test("lists the MediaLive rename and nothing else", () => {
    expect(KNOWN_STALE_PATCHES.map((s) => `${s.typeName}/${s.patchFile}`)).toEqual([`${MEDIALIVE}/format.json`]);
  });
});
