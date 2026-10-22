/** Branch routing and label filters for the pull-request loop (#4292). */

import { describe, expect, test } from "vitest";
import { appliesFrom, plansUnderLabels, pushedBranchFromEnv, routeConflicts, routedBranch } from "./ci-branches";

const branches = { release: ["prod-*", "dr"], staging: ["staging-*"] };

describe("ci.branches", () => {
  test("a member routes to the first branch whose globs match it, or to none", () => {
    expect(routedBranch(branches, "prod-eu")).toBe("release");
    expect(routedBranch(branches, "dr")).toBe("release");
    expect(routedBranch(branches, "staging-a")).toBe("staging");
    expect(routedBranch(branches, "api")).toBeNull();
    expect(routedBranch(undefined, "api")).toBeNull();
  });

  test("a routed member applies from its branch alone", () => {
    expect(appliesFrom(branches, "prod-eu", "release")).toEqual({ applies: true, note: "ci.branches: release applies member prod-eu" });
    expect(appliesFrom(branches, "prod-eu", "main")).toEqual({ applies: false, note: "ci.branches: member prod-eu applies from release, not main" });
    expect(appliesFrom(branches, "prod-eu", "staging").applies).toBe(false);
  });

  test("an unrouted member applies from every branch the map does not name", () => {
    expect(appliesFrom(branches, "api", "main").applies).toBe(true);
    expect(appliesFrom(branches, "api", "hotfix").applies).toBe(true);
    expect(appliesFrom(branches, "api", "release")).toEqual({
      applies: false,
      note: "ci.branches: release applies only the members its globs match, and member api is not one",
    });
    expect(appliesFrom(undefined, "api", "release").applies).toBe(true);
  });

  test("a member two branches match is a conflict", () => {
    expect(routeConflicts({ release: ["prod-*"], hotfix: ["prod-eu"] }, ["prod-eu", "prod-us", "api"])).toEqual([{ member: "prod-eu", branches: ["release", "hotfix"] }]);
    expect(routeConflicts(branches, ["prod-eu", "dr", "api"])).toEqual([]);
  });

  test("the pushed branch comes from the forge's variables, never from a tag ref", () => {
    expect(pushedBranchFromEnv({ GITHUB_REF_NAME: "release", GITHUB_REF_TYPE: "branch" })).toBe("release");
    expect(pushedBranchFromEnv({ GITHUB_REF_NAME: "v1.2.0", GITHUB_REF_TYPE: "tag" })).toBeUndefined();
    expect(pushedBranchFromEnv({ CI_COMMIT_BRANCH: "release" })).toBe("release");
    expect(pushedBranchFromEnv({})).toBeUndefined();
  });
});

describe("ci.labels", () => {
  const labels = { "plan:prod": ["prod-*"], "plan:web": ["web"] };

  test("with none of the labels on the pull request, every member plans", () => {
    expect(plansUnderLabels(labels, "api", [])).toEqual({ plans: true });
    expect(plansUnderLabels(labels, "api", ["bug"])).toEqual({ plans: true });
    expect(plansUnderLabels(undefined, "api", ["plan:prod"])).toEqual({ plans: true });
  });

  test("with some, only the members their globs match plan", () => {
    expect(plansUnderLabels(labels, "prod-eu", ["plan:prod"])).toEqual({ plans: true, note: "ci.labels: plan:prod plans member prod-eu" });
    expect(plansUnderLabels(labels, "web", ["plan:prod", "plan:web"]).plans).toBe(true);
    const out = plansUnderLabels(labels, "api", ["plan:prod", "bug"]);
    expect(out.plans).toBe(false);
    expect(out.note).toContain("its record and apply on merge still plan it");
  });
});
