import { describe, expect, test } from "vitest";
import { parseEngineSyntax } from "./engine-syntax";

const names = (syntax: string) =>
  parseEngineSyntax(syntax)?.args.map((a) => `${a.optional ? "?" : ""}${a.name}${a.repeated ? "..." : ""}${a.named ? "=" : ""}`);

describe("reading an engine's arguments from its syntax line", () => {
  test("nested optional brackets mark every argument inside them optional", () => {
    expect(names("ENGINE = ReplacingMergeTree([ver [, is_deleted]]) ORDER BY expr")).toEqual(["?ver", "?is_deleted"]);
  });

  test("an empty list and no list are different shapes", () => {
    expect(parseEngineSyntax("ENGINE = MergeTree() ORDER BY expr")).toEqual({ name: "MergeTree", parenthesised: true, args: [] });
    expect(parseEngineSyntax("ENGINE = Log")).toEqual({ name: "Log", parenthesised: false, args: [] });
  });

  test("a quoted placeholder is a string literal argument", () => {
    const parsed = parseEngineSyntax("ENGINE = ReplicatedMergeTree('zoo_path', 'replica_name') ORDER BY expr");
    expect(parsed?.args.map((a) => [a.name, a.quoted])).toEqual([
      ["zoo_path", true],
      ["replica_name", true],
    ]);
  });

  test("alternatives become one argument, and a trailing ... repeats the last", () => {
    expect(names("ENGINE = File(format[, path | fd])")).toEqual(["format", "?path|fd"]);
    expect(names("ENGINE = Join(join_strictness, join_type, k1[, k2, ...])")).toEqual([
      "join_strictness",
      "join_type",
      "k1",
      "?k2...",
    ]);
  });

  test("name = value is a named parameter", () => {
    expect(names("INDEX name expr TYPE text(tokenizer = splitByNonAlpha) GRANULARITY g")).toEqual(["tokenizer="]);
  });

  test("a skip index line is read the same way as an engine line", () => {
    expect(names("INDEX name expr TYPE ngrambf_v1(n, size_in_bytes, num_hash_functions, seed) GRANULARITY g")).toEqual([
      "n",
      "size_in_bytes",
      "num_hash_functions",
      "seed",
    ]);
  });

  test("a line that is not an ENGINE or INDEX line is not guessed at", () => {
    expect(parseEngineSyntax("CREATE MATERIALIZED VIEW name [TO target] AS SELECT ...")).toBeUndefined();
    expect(parseEngineSyntax("")).toBeUndefined();
    expect(parseEngineSyntax("ENGINE = Broken(a]")).toBeUndefined();
  });
});
