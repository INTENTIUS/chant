import { describe, test, expect } from "bun:test";
import { generate } from "./generate";
import { loadSchemaFixtures } from "../testdata/load-fixtures";

describe("snapshot tests", () => {
  // Generate once for all snapshot tests
  let result: Awaited<ReturnType<typeof generate>>;

  test("generate from fixtures", async () => {
    const fixtures = loadSchemaFixtures();
    result = await generate({ schemaSource: fixtures });
    expect(result.resources).toBeGreaterThanOrEqual(5);
  });

  test("Bucket lexicon entry", () => {
    const lexicon = JSON.parse(result.lexiconJSON);
    const bucket = lexicon["Bucket"];
    expect(bucket).toBeDefined();
    expect(bucket).toMatchSnapshot();
  });

  test("Function lexicon entry", () => {
    const lexicon = JSON.parse(result.lexiconJSON);
    const fn = lexicon["Function"];
    expect(fn).toBeDefined();
    expect(fn).toMatchSnapshot();
  });

  test("Role lexicon entry", () => {
    const lexicon = JSON.parse(result.lexiconJSON);
    const role = lexicon["Role"];
    expect(role).toBeDefined();
    expect(role).toMatchSnapshot();
  });

  test("generated resource names", () => {
    const lexicon = JSON.parse(result.lexiconJSON);
    const names = Object.keys(lexicon).sort();
    expect(names).toMatchSnapshot();
  });

  test("Bucket .d.ts class declaration", () => {
    // Extract the Bucket class from typesDTS
    const lines = result.typesDTS.split("\n");
    const bucketStart = lines.findIndex((l) => /class\s+Bucket\b/.test(l));
    expect(bucketStart).toBeGreaterThan(-1);

    // Find closing brace (simple: next line with just "}")
    let bucketEnd = bucketStart + 1;
    let braceDepth = 1;
    while (bucketEnd < lines.length && braceDepth > 0) {
      const line = lines[bucketEnd];
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      bucketEnd++;
    }

    const bucketClass = lines.slice(bucketStart, bucketEnd).join("\n");
    expect(bucketClass).toMatchSnapshot();
  });

  test("Function .d.ts class declaration", () => {
    const lines = result.typesDTS.split("\n");
    // Look for "class Function" or "class LambdaFunction" — naming may vary
    const fnStart = lines.findIndex((l) => /class\s+(Function|LambdaFunction)\b/.test(l));
    expect(fnStart).toBeGreaterThan(-1);

    let fnEnd = fnStart + 1;
    let braceDepth = 1;
    while (fnEnd < lines.length && braceDepth > 0) {
      const line = lines[fnEnd];
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      fnEnd++;
    }

    const fnClass = lines.slice(fnStart, fnEnd).join("\n");
    expect(fnClass).toMatchSnapshot();
  });
});
