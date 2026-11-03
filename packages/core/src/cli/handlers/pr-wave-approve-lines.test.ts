/**
 * #4574: pr-apply's lines for a waiting component wave or round name one
 * approve line per component under a product's words, as the note does
 * (#4601). chant's own line is what it was.
 */
import { afterEach, describe, expect, test } from "vitest";
import { assertProductWords, setActiveProductWords } from "../../ci-product-words";
import { waveApproveLines } from "./pr";

const digest = `sha256:${"d".repeat(64)}`;

afterEach(() => {
  setActiveProductWords(undefined);
});

describe("waveApproveLines (#4574)", () => {
  test("chant's words: one line, no target", () => {
    expect(waveApproveLines("chant-pr", "dev", { gate: "wave-1", digest, components: ["a", "b"] })).toBe(`chant approve chant-pr wave-1 --plan ${digest} --approver <you> --sign`);
  });

  test("a product's {target}: one line per component, else the environment", () => {
    setActiveProductWords(assertProductWords({ product: "yodel", approve: "yodel approve {target} --plan {digest}" }));
    expect(waveApproveLines("op", "dev", { gate: "wave-1", digest, components: ["app"] })).toBe(`yodel approve app --plan ${digest}`);
    expect(waveApproveLines("op", "dev", { gate: "wave-1", digest, components: ["a", "b"] })).toBe(`yodel approve a --plan ${digest}; yodel approve b --plan ${digest}`);
    expect(waveApproveLines("op", "dev", { gate: "wave-1", digest, components: [] })).toBe(`yodel approve dev --plan ${digest}`);
  });

  test("a product's template with no {target}: one line", () => {
    setActiveProductWords(assertProductWords({ product: "plywood", approve: "plywood approve {gate} --plan {digest} {sign}" }));
    expect(waveApproveLines("op", "dev", { gate: "wave-1", digest, components: ["a", "b"] })).toBe(`plywood approve wave-1 --plan ${digest} --sign`);
  });
});
