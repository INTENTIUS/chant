/**
 * Build-time parameters from workspace flags (#4024): what a build for an
 * environment resolves in a member with flags, and the precedence rule that a
 * flag-backed parameter can't be overridden where the environment has a gate.
 * On the fixture in `workspace/__fixtures__/flag-workspace.ts`, where member
 * `shop`'s component declares a gate and member `blog`'s does not.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { buildCommand } from "./cli/commands/build";
import type { Serializer } from "./serializer";
import type { BuildParamsConfig } from "./build-params";
import { loadBuildParamFlags, resolveFlaggedBuildParams } from "./flag-params";
import { cleanScratch, scratchDir } from "./workspace/__fixtures__/contract-repo";
import { flagWorkspace } from "./workspace/__fixtures__/flag-workspace";

const SHOP: BuildParamsConfig = { newCheckout: { type: "boolean", default: false }, tier: { type: "string", default: "small" } };
const BLOG: BuildParamsConfig = { banner: { type: "boolean", default: false } };

let root: string;
beforeAll(() => {
  root = flagWorkspace();
});
afterAll(cleanScratch);

const quiet = { echo: false } as const;

describe("loadBuildParamFlags", () => {
  test("outside a workspace, and without an environment, there are no flags", async () => {
    const plain = scratchDir("chant-flags-plain-");
    expect(await loadBuildParamFlags(plain, "prod")).toEqual({ flags: undefined, errors: [] });
    expect(await loadBuildParamFlags(join(root, "shop"), undefined)).toEqual({ flags: undefined, errors: [] });
  });

  test("in a member, each flag-backed parameter with the flag's value for the environment", async () => {
    expect(await loadBuildParamFlags(join(root, "shop"), "dev")).toEqual({
      flags: { env: "dev", byParam: { newCheckout: { flag: "new-checkout", value: true } } },
      errors: [],
    });
  });

  test("a flag kind that can't be read stops the build rather than building without its flags", async () => {
    const dir = flagWorkspace({ "flags/flag.schema.json": "{ not json" });
    const loaded = await loadBuildParamFlags(join(dir, "shop"), "prod");
    expect(loaded.flags).toBeUndefined();
    expect(loaded.errors[0]).toMatch(/the workspace's flag records can't be read/);
  });
});

describe("resolveFlaggedBuildParams", () => {
  test("records the flag as the parameter's source, per environment", async () => {
    const prod = await resolveFlaggedBuildParams(join(root, "shop"), SHOP, quiet, "prod");
    expect(prod).toEqual({
      success: true,
      errors: [],
      provenance: [
        { name: "newCheckout", value: false, source: "flag:new-checkout" },
        { name: "tier", value: "small", source: "default" },
      ],
    });
    const dev = await resolveFlaggedBuildParams(join(root, "shop"), SHOP, quiet, "dev");
    expect(dev.provenance[0]).toEqual({ name: "newCheckout", value: true, source: "flag:new-checkout" });
    // staging: the record gives no value, so the declared default applies.
    expect((await resolveFlaggedBuildParams(join(root, "shop"), SHOP, quiet, "staging")).provenance[0]).toEqual({ name: "newCheckout", value: false, source: "default" });
  });

  test("--param can't override a flag in an environment with a gate: the build refuses", async () => {
    const refused = await resolveFlaggedBuildParams(join(root, "shop"), SHOP, { ...quiet, cli: { newCheckout: "true" } }, "prod");
    expect(refused.success).toBe(false);
    expect(refused.provenance).toEqual([]);
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]).toMatch(/build parameter "newCheckout" is backed by the flag "new-checkout", and "prod" has a gate, so --param can't set it/);
    expect(refused.errors[0]).toMatch(/gates: prod-release/);
  });

  test("--params-file can't either, and a parameter no flag backs still can", async () => {
    const file = join(scratchDir("chant-flags-file-"), "params.json");
    writeFileSync(file, JSON.stringify({ newCheckout: true }));
    const refused = await resolveFlaggedBuildParams(join(root, "shop"), SHOP, { ...quiet, paramsFile: file }, "prod");
    expect(refused.success).toBe(false);
    expect(refused.errors[0]).toMatch(/so --params-file can't set it/);
    const tier = await resolveFlaggedBuildParams(join(root, "shop"), SHOP, { ...quiet, cli: { tier: "large" } }, "prod");
    expect(tier.success).toBe(true);
    expect(tier.provenance).toContainEqual({ name: "tier", value: "large", source: "cli" });
  });

  test("where no component declares a gate, --param still overrides the flag", async () => {
    const r = await resolveFlaggedBuildParams(join(root, "blog"), BLOG, { ...quiet, cli: { banner: "false" } }, "prod");
    expect(r.success).toBe(true);
    expect(r.provenance).toEqual([{ name: "banner", value: false, source: "cli" }]);
  });

  test("components that can't be read refuse an override, since the gate can't be ruled out", async () => {
    const dir = flagWorkspace({ "shop/broken.component.ts": "export const = ;\n" });
    const r = await resolveFlaggedBuildParams(join(dir, "shop"), SHOP, { ...quiet, cli: { newCheckout: "true" } }, "prod");
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatch(/whether "prod" has a gate can't be told/);
  });
});

describe("chant build --env in a member with flags", () => {
  const runtime = join(import.meta.dirname, "runtime");
  const paramsModule = join(import.meta.dirname, "params");
  const serializer: Serializer = {
    name: "aws",
    rulePrefix: "TEST",
    serialize: (entities) => JSON.stringify([...entities.values()].map((e) => (e as unknown as { props: unknown }).props)),
  };
  const shopFiles = {
    "shop/chant.config.ts": `export default { environments: ["dev", "staging", "prod"], buildParams: { newCheckout: { type: "boolean", default: false } } };\n`,
    "shop/main.ts":
      `import { createResource } from ${JSON.stringify(runtime)};\n` +
      `import { params } from ${JSON.stringify(paramsModule)};\n` +
      `const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });\n` +
      `export const bucket = new Bucket({ checkout: params.newCheckout ? "new" : "old" });\n`,
  };

  test("records the flag on BuildResult.buildParams and builds with its value", async () => {
    const dir = flagWorkspace(shopFiles);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await buildCommand({ path: join(dir, "shop"), format: "json", serializers: [serializer], env: "dev" });
      expect(result.errors).toEqual([]);
      expect(result.buildParams).toEqual([{ name: "newCheckout", value: true, source: "flag:new-checkout" }]);
      expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes("1 build parameter resolved (1 from flags)"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("refuses --param for a flag-backed parameter in an environment with a gate", async () => {
    const dir = flagWorkspace(shopFiles);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await buildCommand({ path: join(dir, "shop"), format: "json", serializers: [serializer], env: "prod", params: { newCheckout: "true" } });
      expect(result.success).toBe(false);
      expect(result.errors.join("\n")).toMatch(/"newCheckout" is backed by the flag "new-checkout", and "prod" has a gate, so --param can't set it/);
    } finally {
      spy.mockRestore();
    }
  });
});
