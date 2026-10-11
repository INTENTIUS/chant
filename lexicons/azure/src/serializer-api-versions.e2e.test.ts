import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import {
  azureSerializer,
  apiVersionRegistryCandidates,
  getApiVersion,
  loadApiVersions,
  resetApiVersionCache,
} from "./serializer";
import { PROVIDER_VERSION_OVERRIDES } from "./spec/api-versions";

function makeEntity(entityType: string, props: Record<string, unknown> = {}): any {
  return { [DECLARABLE_MARKER]: true, lexicon: "azure", entityType, kind: "resource", props };
}

// This file runs as ESM (package.json "type": "module"), so `require` is not
// defined in module scope — the path #1581 broke.
describe("apiVersion registry under ESM (#1581)", () => {
  afterEach(() => resetApiVersionCache());

  it("resolves pinned versions in a real ESM process (no require shim)", () => {
    // vitest defines a module-scope `require`, which hid #1581. Run the
    // serializer under plain tsx ESM, where `require` is undefined.
    const here = dirname(fileURLToPath(import.meta.url));
    const script = [
      `import { azureSerializer } from ${JSON.stringify(join(here, "serializer.ts"))};`,
      `import { DECLARABLE_MARKER } from "@intentius/chant/declarable";`,
      `const entities = new Map();`,
      `entities.set("vm", { [DECLARABLE_MARKER]: true, lexicon: "azure", entityType: "Microsoft.Compute/virtualMachines", kind: "resource", props: { name: "vm", location: "eastus" } });`,
      `const t = JSON.parse(azureSerializer.serialize(entities));`,
      `console.log(JSON.stringify({ req: typeof require, apiVersion: t.resources[0].apiVersion }));`,
    ].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "azure-esm-"));
    try {
      const file = join(dir, "probe.mts");
      writeFileSync(file, script);
      const out = execFileSync("npx", ["tsx", file], { cwd: here, encoding: "utf-8", timeout: 120_000 });
      const { req, apiVersion } = JSON.parse(out.trim().split("\n").pop()!);
      expect(req).toBe("undefined");
      expect(PROVIDER_VERSION_OVERRIDES["Microsoft.Compute"]).toContain(apiVersion);
      expect(apiVersion).not.toBe("2023-01-01");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads the registry via import.meta.url and uses pinned versions", () => {
    const versions = loadApiVersions();
    expect(versions.size).toBeGreaterThan(100);

    // The pinned Microsoft.Compute version (spec/api-versions.ts) must reach
    // the serializer, not the uniform 2023-01-01 fallback.
    const computePins = PROVIDER_VERSION_OVERRIDES["Microsoft.Compute"];
    expect(computePins?.length).toBeGreaterThan(0);
    expect(computePins).toContain(versions.get("Microsoft.Compute/virtualMachines"));

    const entities = new Map<string, any>();
    entities.set("vm", makeEntity("Microsoft.Compute/virtualMachines", { name: "vm", location: "eastus" }));
    entities.set("sa", makeEntity("Microsoft.Storage/storageAccounts", { name: "sa", location: "eastus" }));
    const template = JSON.parse(azureSerializer.serialize(entities) as string);
    const byType = Object.fromEntries(template.resources.map((r: any) => [r.type, r.apiVersion]));
    expect(computePins).toContain(byType["Microsoft.Compute/virtualMachines"]);
    expect(byType["Microsoft.Storage/storageAccounts"]).toBe(versions.get("Microsoft.Storage/storageAccounts"));
    expect(byType["Microsoft.Storage/storageAccounts"]).not.toBe("2023-01-01");
  });

  it("throws loudly when no registry can be found", () => {
    const dir = mkdtempSync(join(tmpdir(), "azure-apiv-"));
    try {
      expect(() => loadApiVersions(apiVersionRegistryCandidates(dir))).toThrow(/apiVersion registry not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on an empty registry rather than falling back uniformly", () => {
    const dir = mkdtempSync(join(tmpdir(), "azure-apiv-"));
    try {
      writeFileSync(join(dir, "meta.json"), "{}");
      expect(() => loadApiVersions([join(dir, "meta.json")])).toThrow(/registry is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps explicit overrides ahead of the registry", () => {
    expect(getApiVersion("Microsoft.Authorization/roleAssignments")).toBe("2022-04-01");
  });
});
