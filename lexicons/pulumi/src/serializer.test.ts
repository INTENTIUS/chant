import { describe, expect, test } from "vitest";
import { pulumiSerializer } from "./serializer";

describe("pulumiSerializer", () => {
  test("a build that names the lexicon gets an empty document: it declares nothing", () => {
    expect(pulumiSerializer.serialize(new Map())).toEqual({ primary: "{}\n", files: {} });
    expect(pulumiSerializer.rulePrefix).toBe("PUL");
  });
});
