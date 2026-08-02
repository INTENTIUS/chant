/**
 * Every composite has to be reachable from the package root.
 *
 * The root barrel re-exports composites through a hand-maintained list, so a
 * new composite is exported from `composites/index` — where its own tests
 * import it from — and silently missing from `@intentius/chant-lexicon-aws`.
 * `MicrovmApp` shipped that way in 0.33.0 and was only noticed by a consumer
 * project whose import failed at runtime (#1219). `SolrFargateService` had the
 * same gap and nobody had hit it yet.
 */

import { describe, expect, test } from "vitest";
import * as composites from "./index";
import * as root from "../index";

describe("the root barrel re-exports every composite", () => {
  const exported = Object.keys(composites);

  test("there is something to check", () => {
    expect(exported.length).toBeGreaterThan(20);
  });

  test.each(exported)("%s is reachable from the package root", (name) => {
    expect(root, `${name} is exported from composites/index but not from the root barrel`).toHaveProperty(name);
  });

  test("and reaches the same binding, not a same-named generated resource", () => {
    for (const name of exported) {
      expect((root as Record<string, unknown>)[name]).toBe((composites as Record<string, unknown>)[name]);
    }
  });
});
