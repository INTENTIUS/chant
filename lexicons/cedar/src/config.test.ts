import { describe, expect, it } from "vitest";
import { cedarConfigSchema, CEDAR_DEFAULT_SCHEMA_PATH } from "./config";
import { cedarPlugin } from "./plugin";
import { resolveSchemaPath, defaultSchemaPath } from "./spec/fetch";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("cedar config namespace", () => {
  it("is declared on the plugin, so core validates it at load", () => {
    expect(cedarPlugin.configSchema).toBe(cedarConfigSchema);
  });

  it("accepts the documented shape", () => {
    const parsed = cedarConfigSchema.parse({
      schema: "authz/app.cedarschema",
      validation: { mode: "strict", warnings: "warn", requireProjectSchema: true },
    });
    expect(parsed.schema).toBe("authz/app.cedarschema");
  });

  it("rejects an unknown key inside the namespace", () => {
    expect(() => cedarConfigSchema.parse({ shema: "app.cedarschema" })).toThrow();
  });

  it("rejects an unknown key one level down, where a typo actually lands", () => {
    expect(() => cedarConfigSchema.parse({ validation: { requireSchema: true } })).toThrow();
  });

  it("rejects a validation mode cedar-wasm does not implement", () => {
    // `ValidationMode` in 4.12.0 is `"strict"` and nothing else; anything more
    // throws from inside the wasm rather than returning a failure (#1648 §5.7).
    expect(() => cedarConfigSchema.parse({ validation: { mode: "permissive" } })).toThrow();
  });

  it("leaves everything optional, so an empty namespace is legal", () => {
    expect(cedarConfigSchema.parse({})).toEqual({});
  });

  it("takes the dogwood binary path (#1659)", () => {
    const parsed = cedarConfigSchema.parse({ dogwood: { binary: "../dogwood/target/release/dogwood" } });
    expect(parsed.dogwood?.binary).toBe("../dogwood/target/release/dogwood");
  });

  it("rejects a typo in the dogwood namespace, where a silent skip would follow", () => {
    // A misspelled key here means "no binary found", and "no binary found" is
    // an advisory rather than a failure — exactly the case strictObject exists
    // to catch before it turns into a validation gap nobody notices.
    expect(() => cedarConfigSchema.parse({ dogwood: { path: "/usr/local/bin/dogwood" } })).toThrow();
  });
});

describe("schema resolution", () => {
  it("falls back to the bundled default when the project has no schema", () => {
    const resolved = resolveSchemaPath({ projectRoot: join(pkgDir, "nowhere") });
    expect(resolved.isDefault).toBe(true);
    expect(resolved.path).toBe(defaultSchemaPath());
  });

  it("reads the configured path when it exists", () => {
    const example = join(pkgDir, "examples", "basic-policies");
    const resolved = resolveSchemaPath({ projectRoot: example, config: { schema: "schema.cedarschema" } });
    expect(resolved.isDefault).toBe(false);
    expect(resolved.path).toBe(join(example, "schema.cedarschema"));
  });

  it("looks for the default filename when nothing is configured", () => {
    const example = join(pkgDir, "examples", "basic-policies");
    expect(CEDAR_DEFAULT_SCHEMA_PATH).toBe("schema.cedarschema");
    expect(resolveSchemaPath({ projectRoot: example }).path).toBe(join(example, CEDAR_DEFAULT_SCHEMA_PATH));
  });

  it("refuses the fallback when requireProjectSchema is on", () => {
    expect(() =>
      resolveSchemaPath({
        projectRoot: join(pkgDir, "nowhere"),
        config: { validation: { requireProjectSchema: true } },
      }),
    ).toThrow(/no schema found/);
  });
});

describe("upstream pin declaration", () => {
  it("points at a constant its own pattern finds", async () => {
    const pin = cedarPlugin.upstreamPin;
    expect(pin).toBeDefined();
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(join(pkgDir, pin!.file), "utf-8");
    const match = pin!.pattern.exec(source);
    expect(match?.[1]).toBe("4.12.0");
    expect(pin!.replace("4.13.0", match![0])).toContain('"4.13.0"');
  });
});
