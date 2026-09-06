/**
 * The registry contract (#2086): activities are discovered by convention, not
 * by a plugin member. `loadActivities` (`packages/core/src/op/
 * activity-registry.ts`) imports
 * `@intentius/chant-lexicon-terraform/op/activities` for every configured
 * lexicon and keys each exported function by name, so the `"./op/activities"`
 * entry in this lexicon's package.json is load-bearing and this test is what
 * notices if it goes missing.
 *
 * Nothing here runs terraform: resolving a name is importing a module, not
 * calling it.
 */

import { describe, test, expect } from "vitest";
import { loadActivities, resolveActivity } from "@intentius/chant/op";

describe("loadActivities([\"terraform\"]) (#2086)", () => {
  test("resolves all four activity names", async () => {
    const activities = await loadActivities(["terraform"]);
    for (const name of ["terraformInit", "terraformPlan", "terraformApply", "terraformShow"]) {
      expect(typeof resolveActivity(activities, name)).toBe("function");
    }
  });

  test("a project that does not list terraform gets none of them", async () => {
    const activities = await loadActivities([]);
    expect(activities.has("terraformApply")).toBe(false);
  });
});
