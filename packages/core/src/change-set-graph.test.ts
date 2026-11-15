/**
 * Mapping a change set's entries onto graph node ids (#4022). The real-estate
 * tests read the graph from `chant graph --format ir`: the five tofu roots in
 * `lexicons/terraform/src/components/pr-loop.tofu.test.ts` and the aws
 * workspace member in `lifecycle/gate-change-set.e2e.test.ts`. This holds the
 * address rules and the digest.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeChangeSet, lifecyclePlanPart, reconcilePlanPart, verifyChangeSetDigest, type ChangeSetEntry } from "./change-set";
import { changeSetNodeCandidates, mapChangeSetToGraph, terraformBlockKey } from "./change-set-graph";
import type { ChangeSet as LifecycleChangeSet } from "./lifecycle/change-set";

const plan = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "change-set", "lifecycle-plan.floci.json"), "utf8")) as LifecycleChangeSet;

describe("terraformBlockKey", () => {
  test("names the block the terraform lexicon keys, without the instance index", () => {
    expect(terraformBlockKey("terraform_data.keep")).toBe("terraform_data.keep");
    expect(terraformBlockKey("module.app.terraform_data.instance[0]")).toBe("module.app/terraform_data.instance");
    expect(terraformBlockKey('module.cdn["eu"].module.bucket[1].aws_s3_bucket.this["a.b]"]')).toBe("module.cdn/module.bucket/aws_s3_bucket.this");
    expect(terraformBlockKey("data.aws_iam_policy.boundary")).toBe("data.aws_iam_policy.boundary");
    expect(terraformBlockKey("module.app.data.aws_ami.ubuntu")).toBe("module.app/data.aws_ami.ubuntu");
  });

  test("a terraform entry tries <root>/<block key>, then its address", () => {
    expect(changeSetNodeCandidates({ member: "estate", planner: "tofu", address: "module.app.terraform_data.instance[1]" })).toEqual([
      "estate/module.app/terraform_data.instance",
      "module.app.terraform_data.instance[1]",
    ]);
    expect(changeSetNodeCandidates({ member: "delivery", planner: "chant", address: "jobs" })).toEqual(["jobs"]);
    expect(changeSetNodeCandidates({ member: "org", planner: "warden", address: "team.platform" })).toEqual(["team.platform"]);
  });

  test("a warden change under a node tries its address, then the node id before the # (#5089)", () => {
    expect(changeSetNodeCandidates({ member: "forge", planner: "warden", address: "repo/acme/api#approval-rule[#review]" })).toEqual([
      "repo/acme/api#approval-rule[#review]",
      "repo/acme/api",
    ]);
    expect(changeSetNodeCandidates({ member: "forge", planner: "warden", address: "repo/acme/api" })).toEqual(["repo/acme/api"]);
  });
});

describe("a warden's plan on its forge-governance graph (#5089)", () => {
  test("entries with graph-node addresses sit on the nodes, and two orgs' same-named repos stay apart", () => {
    const part = reconcilePlanPart({
      member: "forge",
      plan: [
        { org: "acme", entries: [
          { kind: "update", resourceType: "repo", key: "api", address: "repo/acme/api", fields: [{ field: "hasWiki", before: true, after: false }] },
          { kind: "create", resourceType: "repo-secret", key: "api/TOKEN", address: "repo/acme/api#repo-secret[#api/TOKEN]", after: { name: "TOKEN" } },
        ] },
        { org: "beta", entries: [{ kind: "update", resourceType: "repo", key: "api", address: "repo/beta/api", fields: [{ field: "hasWiki", before: true, after: false }] }] },
        { org: "beta", entries: [{ kind: "delete", resourceType: "team", key: "old", before: { slug: "old" } }] },
      ],
    });
    expect(part.entries.map((e) => e.address)).toEqual(["repo/acme/api", "repo/acme/api#repo-secret[#api/TOKEN]", "repo/beta/api", "team.old"]);
    const mapped = mapChangeSetToGraph(composeChangeSet([part]), { member: "forge", at: null, ids: ["org/acme", "repo/acme/api", "org/beta", "repo/beta/api"] });
    expect(mapped.entries.map((e) => [e.address, e.node])).toEqual([
      ["repo/acme/api", "forge/repo/acme/api"],
      ["repo/acme/api#repo-secret[#api/TOKEN]", "forge/repo/acme/api"],
      ["repo/beta/api", "forge/repo/beta/api"],
      ["team.old", null],
    ]);
  });
});

describe("mapChangeSetToGraph", () => {
  const doc = composeChangeSet([lifecyclePlanPart({ member: "delivery", plan })]);

  test("keeps the ids the graph holds, puts the member in front, and leaves the digest alone", () => {
    const mapped = mapChangeSetToGraph(doc, { member: "delivery", at: "a".repeat(40), ids: ["jobs", "events", "dlq"] });
    expect(mapped.entries.map((e) => [e.address, e.node])).toEqual([
      ["alerts", null],
      ["dlq", "delivery/dlq"],
      ["events", "delivery/events"],
      ["jobs", "delivery/jobs"],
    ]);
    expect(mapped.graph).toEqual({ member: "delivery", at: "a".repeat(40) });
    expect(mapped.digest).toBe(doc.digest);
    expect(verifyChangeSetDigest(mapped)).toBe(true);
  });

  test("outside a workspace the id is the member's own", () => {
    const mapped = mapChangeSetToGraph(doc, { member: null, at: null, ids: ["jobs"] });
    expect(mapped.entries.find((e) => e.address === "jobs")!.node).toBe("jobs");
  });

  test("no graph gives every entry a null node", () => {
    const mapped = mapChangeSetToGraph(doc, null);
    expect(mapped.graph).toBeNull();
    expect(mapped.entries.every((e: ChangeSetEntry) => e.node === null)).toBe(true);
    expect(verifyChangeSetDigest(mapped)).toBe(true);
  });

  test("a node is not hashed, and every other part of an entry still is", () => {
    const mapped = mapChangeSetToGraph(doc, { member: null, at: null, ids: ["jobs"] });
    const moved = { ...mapped, entries: mapped.entries.map((e) => ({ ...e, node: "elsewhere" })) };
    expect(verifyChangeSetDigest(moved)).toBe(true);
    const changed = { ...mapped, entries: mapped.entries.map((e, i) => (i === 0 ? { ...e, address: "other" } : e)) };
    expect(verifyChangeSetDigest(changed)).toBe(false);
  });
});
