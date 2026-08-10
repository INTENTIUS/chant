/**
 * The `cedar` namespace is read, not just declared (#1344, #1650).
 *
 * A `configSchema` that nothing consumes is worse than none: it validates a key
 * that has no effect, which reads as a working knob. These tests pin the path
 * from `chant.config.ts` to the schema `generate()` actually opens.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCedarConfig } from "./config";
import { resolveSchemaPath } from "./spec/fetch";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("loadCedarConfig", () => {
  it("reads the namespace out of a project config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cedar-config-"));
    writeFileSync(
      join(dir, "chant.config.json"),
      JSON.stringify({ lexicons: ["cedar"], cedar: { schema: "authz/app.cedarschema" } }),
    );
    expect(await loadCedarConfig(dir)).toEqual({ schema: "authz/app.cedarschema" });
  });

  it("returns an empty namespace when the project declares none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cedar-config-"));
    writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: ["cedar"] }));
    expect(await loadCedarConfig(dir)).toEqual({});
  });

  it("reaches the schema the example's config points at", async () => {
    const example = join(pkgDir, "examples", "basic-policies");
    const config = await loadCedarConfig(example);
    expect(config.schema).toBe("schema.cedarschema");
    expect(resolveSchemaPath({ projectRoot: example, config })).toEqual({
      path: join(example, "schema.cedarschema"),
      isDefault: false,
    });
  });
});
