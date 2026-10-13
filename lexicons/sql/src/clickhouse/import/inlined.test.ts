import { describe, expect, test } from "vitest";
import { inlinedFunctions } from "./inlined";

// What the server prints for each, as read from system.functions (#3745).
const FUNCTIONS = [
  { name: "tax", statement: "CREATE FUNCTION tax AS x -> (x * 0.2)" },
  { name: "net", statement: "CREATE FUNCTION net AS (x, y) -> (tax(x) + if(y > 1, y, 0))" },
  { name: "ident", statement: "CREATE FUNCTION ident AS x -> x" },
  { name: "label", statement: "CREATE FUNCTION label AS s -> concat('[', lower(s), ']')" },
];

const found = (...statements: string[]) => inlinedFunctions(statements, FUNCTIONS);

describe("a function found by its body in a stored definition (#3745)", () => {
  test("a column DEFAULT holds the body with the argument in place of the parameter", () => {
    expect(found("CREATE TABLE d.t\n(\n    `id` UInt64,\n    `amt` Float64 DEFAULT id * 0.2\n)\nENGINE = MergeTree\nORDER BY id")).toEqual(["tax"]);
  });

  test("a nested call is matched expanded, and so is the function it calls", () => {
    expect(found("CREATE VIEW d.v\n(\n    `z` Float64\n)\nAS SELECT (amt * 0.2) + if(id > 1, id, 0) AS z\nFROM d.t")).toEqual(["tax", "net"]);
  });

  test("the server's parentheses around the body or an argument don't matter", () => {
    expect(found("CREATE VIEW d.v AS SELECT id FROM d.t WHERE (id * 0.2) > 1")).toEqual(["tax"]);
    expect(found("CREATE VIEW d.v AS SELECT (a + b) * 0.2 AS t FROM d.t")).toEqual(["tax"]);
    expect(found("CREATE VIEW d.v AS SELECT concat('[', lower(name), ']') AS l FROM d.t")).toEqual(["label"]);
  });

  test("a parameter used twice must take the same argument twice", () => {
    expect(found("CREATE VIEW d.v AS SELECT (a * 0.2) + if(b > 1, c, 0) AS z FROM d.t")).toEqual(["tax"]);
  });

  test("two parameters and an operator are enough, so such a body is found wherever that operator is", () => {
    const scale = [{ name: "scale", statement: "CREATE FUNCTION scale AS (x, k) -> (x * k)" }];
    expect(inlinedFunctions(["CREATE VIEW d.v AS SELECT price * qty AS total FROM d.t"], scale)).toEqual(["scale"]);
    expect(inlinedFunctions(["CREATE VIEW d.v AS SELECT price + qty AS total FROM d.t"], scale)).toEqual([]);
  });

  test("a body that is only a parameter is never found, and nothing else is found where the body is absent", () => {
    expect(found("CREATE VIEW d.v AS SELECT id FROM d.t")).toEqual([]);
    expect(found("CREATE VIEW d.v AS SELECT id * 0.3 FROM d.t")).toEqual([]);
  });

  test("an argument never spans a comma or the next clause", () => {
    expect(found("CREATE VIEW d.v AS SELECT a, 0.2 FROM d.t")).toEqual([]);
    expect(found("CREATE VIEW d.v AS SELECT x FROM d.t WHERE 1 + if(y > 1, y, 0)")).toEqual([]);
  });
});
