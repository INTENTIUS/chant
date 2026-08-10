/**
 * Every shipped example builds, and what it builds is real Cedar.
 *
 * "Builds" is what `chant dev check-lexicon` already gates. This file adds the
 * half that matters more: the emitted `.cedar` text and the JSON policy set are
 * handed straight to `cedar-wasm`, so a policy set that chant is happy with but
 * Cedar rejects fails here rather than at deploy time.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkParsePolicySet, type PolicySet } from "@cedar-policy/cedar-wasm/nodejs";
import { build } from "@intentius/chant/build";
import { cedarSerializer, CEDAR_JSON_FILENAME } from "../src/serializer";

const examplesDir = dirname(fileURLToPath(import.meta.url));

const exampleNames = readdirSync(examplesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(examplesDir, e.name, "src")))
  .map((e) => e.name)
  .sort();

describe("cedar examples", () => {
  it("ships at least one example", () => {
    expect(exampleNames.length).toBeGreaterThan(0);
  });

  for (const name of exampleNames) {
    describe(name, () => {
      it("builds and emits both artifacts", async () => {
        const result = await build(join(examplesDir, name, "src"), [cedarSerializer]);
        expect(result.errors).toEqual([]);
        expect(result.outputs.size).toBeGreaterThan(0);
      });

      it("emits .cedar text cedar-wasm parses", async () => {
        const result = await build(join(examplesDir, name, "src"), [cedarSerializer]);

        const output = result.outputs.get("cedar");
        const text = typeof output === "string" ? output : (output?.primary ?? "");
        expect(text.length).toBeGreaterThan(0);

        const answer = checkParsePolicySet({ staticPolicies: text });
        expect(answer.type, JSON.stringify(answer)).toBe("success");
      });

      it("emits the JSON policy-set companion", async () => {
        const result = await build(join(examplesDir, name, "src"), [cedarSerializer]);
        const output = result.outputs.get("cedar");
        const files = typeof output === "string" ? {} : (output?.files ?? {});

        const raw = files[CEDAR_JSON_FILENAME];
        expect(raw, `${CEDAR_JSON_FILENAME} was not emitted`).toBeTruthy();

        const parsed = JSON.parse(raw!) as { staticPolicies: Record<string, unknown> };
        expect(Object.keys(parsed.staticPolicies).length).toBeGreaterThan(0);

        // And it is fed straight back to Cedar. The JSON leg is built from the
        // emitted text by the module itself (#1653), so "well-formed JSON" is
        // no longer the bar — "a policy set Cedar accepts" is.
        const answer = checkParsePolicySet(parsed as unknown as PolicySet);
        expect(answer.type, JSON.stringify(answer)).toBe("success");
      });

      it("emits no serializer warnings", async () => {
        const result = await build(join(examplesDir, name, "src"), [cedarSerializer]);
        const output = result.outputs.get("cedar");
        const warnings = typeof output === "string" ? [] : (output?.warnings ?? []);
        expect(warnings).toEqual([]);
      });
    });
  }

  it("keeps a project schema beside the example that declares one", () => {
    for (const name of exampleNames) {
      const configPath = join(examplesDir, name, "chant.config.ts");
      if (!existsSync(configPath)) continue;
      const config = readFileSync(configPath, "utf-8");
      const match = /schema:\s*"([^"]+)"/.exec(config);
      if (!match) continue;
      expect(
        existsSync(join(examplesDir, name, match[1])),
        `${name}/chant.config.ts points cedar.schema at a file that is not there`,
      ).toBe(true);
    }
  });
});
