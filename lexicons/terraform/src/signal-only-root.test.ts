/**
 * A `signalOnly` root (#4484, C5 of #4477). The dns member declares the azure
 * estate's root only so an azure change brings dns into the change. Change
 * detection counts it; the build and the live reads leave it out, so dns's
 * graph draws only dns's own root and dns's live reads never list azure.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { terraformConfigSchema, ownRoots } from "./config";
import { terraformPlugin } from "./plugin";
import { liveRootNames } from "./describe-resources";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const TERRAFORM: { binary: "choudoufu"; roots: Record<string, { dir: string; signalOnly?: boolean }> } = {
  binary: "choudoufu",
  roots: {
    dns: { dir: "estate" },
    azure: { dir: "../azure", signalOnly: true },
  },
};

/** A workspace slice: `dns/` (the chant member, with its own root under `estate/`) beside `azure/`. */
function estate(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-signal-only-")));
  scratch.push(root);
  const files: Record<string, string> = {
    "dns/chant.config.json": JSON.stringify({ lexicons: ["terraform"], terraform: TERRAFORM }),
    "dns/estate/main.tf": 'resource "null_resource" "zone" {}\n',
    "dns/estate/estate.chdf.hcl": 'estate = "dns"\n',
    "azure/main.tf": 'resource "null_resource" "vnet" {}\n',
    "azure/estate.chdf.hcl": 'estate = "azure"\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return join(root, "dns");
}

describe("a signalOnly root (#4484)", () => {
  test("the config schema takes the marker", () => {
    expect(terraformConfigSchema.safeParse(TERRAFORM).success).toBe(true);
    expect(Object.keys(ownRoots(TERRAFORM.roots))).toEqual(["dns"]);
  });

  test("the build draws only dns's own root, so the azure estate is not drawn under dns", async () => {
    const dns = estate();
    const { entities } = await terraformPlugin.buildRoots!({ projectRoot: dns, config: { terraform: TERRAFORM }, entities: new Map() });
    const keys = [...entities.keys()];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith("dns/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("azure/"))).toBe(false);
  });

  test("the live reads list dns's root and not the azure estate", async () => {
    const dns = estate();
    expect(await liveRootNames(dns)).toEqual([{ root: "dns", estate: "dns" }]);
  });

  test("an azure change still brings dns into the change", async () => {
    const dns = estate();
    const touched = await terraformPlugin.changedUnits!({ projectRoot: dns, config: { terraform: TERRAFORM }, changedFiles: ["../azure/main.tf"] });
    expect(touched).toEqual(["azure"]);
  });
});
