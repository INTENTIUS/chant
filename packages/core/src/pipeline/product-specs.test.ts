/**
 * A product that has not adopted the pipeline sees no change (#5324). The
 * wave job checks a `renderSpec` render against the fold's schema; each
 * product's op-waves spec as it renders it today passes that check and is
 * handed on byte for byte.
 *
 * The fixtures were rendered with each product's own source on 2026-11-19:
 * terragucci's `wavesStepSpec` (init and the apply job) and `wavesSpec` (a
 * Terragrunt repo's discovered waves), plywood's `.chant/op-waves/pulumi-up.spec.json`
 * as `plywood init` writes it (its `wavesSpec`, chant's `productWavesSpec`
 * and `withWavePreview`, bare and in the `{ waves, options }` file), and
 * sql-yodeler's `templates/*\/yodel-waves.json`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertOpWavesSpec } from "../op/op-waves";
import { parseOpWavesSpec } from "../op/op-waves-run";
import { checkRenderedWavesSpec } from "./rendered";

const fixtures = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "product-waves-specs.json"), "utf-8")) as Record<string, Record<string, unknown>>;
const cases = Object.entries(fixtures).flatMap(([product, specs]) => Object.entries(specs).map(([name, spec]) => [`${product} ${name}`, spec] as const));

describe("each product's waves spec today checks against the fold's schema", () => {
  test("every product has fixtures", () => {
    expect(Object.keys(fixtures)).toEqual(["terragucci", "plywood", "sql-yodeler"]);
  });

  test.each(cases)("%s", (name, spec) => {
    const text = `${JSON.stringify(spec, null, 2)}\n`;
    expect(() => assertOpWavesSpec(parseOpWavesSpec(text, name))).not.toThrow();
    // No pipeline document: the render is handed on as printed.
    expect(checkRenderedWavesSpec(text, name, parseOpWavesSpec, {})).toBe(text);
  });
});
