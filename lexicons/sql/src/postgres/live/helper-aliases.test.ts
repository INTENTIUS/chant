/**
 * The catalog read's SQL helpers embed subqueries in their callers' queries,
 * so an alias a helper declares shadows the caller's alias of the same name.
 * A text search dictionary query aliased `pg_ts_dict` as `d` while
 * `notExtensionOwned` and `dependentsOf` aliased `pg_depend` as `d`, and the
 * whole live read failed on every server with "column d.oid does not exist"
 * (chant 0.124.49 and 0.124.50). Unit tests run no server, so this reads the
 * helpers' source instead: a helper's aliases end in `_`, which no caller's
 * one- to three-letter alias does.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const DIR = import.meta.dirname;
const HELPER = /^(?:export )?const ([A-Za-z]+) = \(/;
const SHORT_ALIAS = /(?:FROM|JOIN) pg_catalog\.pg_[a-z_]+ ([a-z]{1,3})\b/g;

describe("the catalog read's SQL helpers", () => {
  test("declare no alias a caller could shadow", () => {
    const found: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const lines = readFileSync(join(DIR, file), "utf-8").split("\n");
      lines.forEach((line, i) => {
        const helper = HELPER.exec(line);
        if (!helper) return;
        const body = lines.slice(i, i + 5).join("\n");
        for (const m of body.matchAll(SHORT_ALIAS)) found.push(`${file}:${String(i + 1)} ${helper[1]} declares ${m[1]}`);
      });
    }
    expect(found).toEqual([]);
  });
});
