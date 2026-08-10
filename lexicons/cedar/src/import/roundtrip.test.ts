/**
 * The epic's round-trip: TypeScript → `.cedar` → parse → TypeScript → `.cedar`,
 * with the two `.cedar` outputs byte-identical.
 *
 * The regenerated TypeScript is checked as source, and the second serialization
 * is driven from the same IR the generator emitted from — running the emitted
 * file would need a compiler in the loop to prove something the IR already
 * decides. `generator.test.ts` covers what that source says.
 *
 * Two normalizations are real and are asserted here rather than hidden:
 *
 * - **Annotation order.** Annotations serialize into a sorted map, so authored
 *   order is not recoverable (#1648 §1). `@id` is always emitted first, and the
 *   rest come back alphabetically.
 * - **Clause order.** `when`/`unless` are separate props, so an interleaved
 *   `when … unless … when` regroups into all `when`s and then all `unless`es.
 *
 * Both settle after one pass, which is what the idempotence test pins.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { checkParsePolicySet } from "@cedar-policy/cedar-wasm/nodejs";
import { cedarSerializer, CEDAR_JSON_FILENAME, CEDAR_POLICY_TYPE } from "../serializer";
import { CedarParser, type CedarPolicyIR } from "./parser";
import { CedarGenerator, loadActionConstants, sanitizeName } from "./generator";

const testdata = (file: string) => readFileSync(join(import.meta.dirname, "testdata", file), "utf8");

/** The declarables an authored `policies.ts` would have produced. */
function declarablesOf(entities: CedarPolicyIR[]): Map<string, Declarable> {
  const map = new Map<string, Declarable>();
  for (const entity of entities) {
    map.set(sanitizeName(entity.name), {
      [DECLARABLE_MARKER]: true,
      lexicon: "cedar",
      entityType: CEDAR_POLICY_TYPE,
      kind: "resource",
      props: entity.props,
    } as unknown as Declarable);
  }
  return map;
}

function serialize(entities: CedarPolicyIR[]): SerializerResult {
  const out = cedarSerializer.serialize(declarablesOf(entities));
  if (typeof out === "string") throw new Error(`expected a SerializerResult, got ${JSON.stringify(out)}`);
  return out;
}

/** One full lap: text in, IR, regenerated TypeScript, text back out. */
function lap(text: string): { entities: CedarPolicyIR[]; source: string; text: string } {
  const { entities } = new CedarParser().parse(text);
  const source = new CedarGenerator({ actionConstants: loadActionConstants() }).generate(entities).source;
  return { entities, source, text: serialize(entities).primary };
}

// ── 1–3. The fixtures ──────────────────────────────────────────────

describe("round-trip", () => {
  for (const fixture of ["simple", "realistic", "full"]) {
    test(`${fixture}.cedar → IR → TypeScript → .cedar is byte-identical`, () => {
      const original = testdata(`${fixture}.cedar`);
      const round = lap(original);

      expect(round.text).toBe(original);
      expect(round.source).toContain("new Policy(");
    });
  }

  test("4. a second lap changes nothing — the normalizations settle after one", () => {
    const first = lap(testdata("full.cedar"));
    const second = lap(first.text);

    expect(second.text).toBe(first.text);
    expect(second.source).toBe(first.source);
    expect(second.entities).toEqual(first.entities);
  });
});

// ── The JSON leg on both sides ─────────────────────────────────────

describe("the JSON leg", () => {
  test("survives the lap and stays a policy set Cedar accepts", () => {
    const original = testdata("full.cedar");
    const round = lap(original);

    const before = JSON.parse(serialize(new CedarParser().parse(original).entities).files![CEDAR_JSON_FILENAME]);
    const after = JSON.parse(serialize(round.entities).files![CEDAR_JSON_FILENAME]);

    expect(after).toEqual(before);
    expect(checkParsePolicySet(after).type).toBe("success");
  });

  test("importing the JSON envelope reaches the same policies as importing the text", () => {
    const fromText = new CedarParser().parse(testdata("full.cedar")).entities;
    const fromJSON = new CedarParser().parse(testdata("full.cedar.json")).entities;

    // Scopes, effects, annotations and clause *count* match exactly; the clause
    // text differs by the module's parenthesization, which is why the text leg
    // is the one that round-trips byte-for-byte.
    const shapeOf = (entities: CedarPolicyIR[]) =>
      entities.map((e) => ({
        kind: e.kind,
        name: e.name,
        ...e.props,
        when: (e.props.when as string[] | undefined)?.length ?? 0,
        unless: (e.props.unless as string[] | undefined)?.length ?? 0,
      }));

    expect(shapeOf(fromJSON)).toEqual(shapeOf(fromText));
  });

  test("a JSON-envelope import still serializes to a policy set Cedar accepts", () => {
    const { entities } = new CedarParser().parse(testdata("full.cedar.json"));
    const result = serialize(entities);

    // The JSON companion is built from the emitted text, so it parsing is the
    // text parsing. `{ staticPolicies: <text> }` would not do here: the
    // document contains a template, and that channel only takes static policies.
    expect(checkParsePolicySet(JSON.parse(result.files![CEDAR_JSON_FILENAME])).type).toBe("success");
    expect(result.warnings ?? []).toEqual([]);
  });
});
