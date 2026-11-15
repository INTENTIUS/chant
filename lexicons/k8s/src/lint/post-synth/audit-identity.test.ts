import { beforeAll, describe, test, expect } from "vitest";
import { auditFiles } from "@intentius/chant/audit/core";
import { buildReportJson } from "@intentius/chant/audit/report-model";
import { wk8105 } from "./wk8105";
import { wk8201 } from "./wk8201";
import { wk8203 } from "./wk8203";

const checks = [wk8105, wk8201, wk8203];

const deployment = (containers: string[]) =>
  [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: slack-welcomer",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    ...containers.flatMap((c) => [`        - name: ${c}`, "          image: example.com/app:1.0"]),
    "",
  ].join("\n");

async function report(content: string) {
  const findings = await auditFiles([{ path: "app.yaml", content, lexicon: "k8s" }], { checksProvider: async () => checks });
  return buildReportJson(findings).findings;
}

describe("finding identity (#5106)", () => {
  // The first audit pays for loading the rule catalog; keep that out of the per-test budget.
  beforeAll(async () => {
    await report(deployment(["warm"]));
  }, 60_000);

  test("renaming a container changes every message and no identity", async () => {
    const before = await report(deployment(["slack-moderator"]));
    const after = await report(deployment(["slack-welcomer"]));
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(after.map((f) => f.checkId)).toEqual(before.map((f) => f.checkId));
    expect(after.map((f) => f.message)).not.toEqual(before.map((f) => f.message));
    expect(after.map((f) => f.identity)).toEqual(before.map((f) => f.identity));
  });

  test("two containers keep their own identities when the first stops having the defect", async () => {
    const two = await report(deployment(["a", "b"]));
    const secondOf = (fs: typeof two, id: string) => fs.filter((f) => f.checkId === id)[1]?.identity;
    const fixedFirst = deployment(["a", "b"]).replace("- name: a\n          image: example.com/app:1.0", "- name: a\n          image: example.com/app:1.0\n          imagePullPolicy: Always");
    const after = await report(fixedFirst);
    const pullPolicy = (fs: typeof two) => fs.filter((f) => f.checkId === "WK8105");
    expect(pullPolicy(two)).toHaveLength(2);
    expect(pullPolicy(after)).toHaveLength(1);
    expect(pullPolicy(after)[0].identity).toBe(secondOf(two, "WK8105"));
  });

  test("identities are distinct within a report", async () => {
    const fs = await report(deployment(["a", "b", "c"]));
    expect(new Set(fs.map((f) => f.identity)).size).toBe(fs.length);
  });

  test("renaming the Deployment changes the identity", async () => {
    const before = await report(deployment(["a"]));
    const after = await report(deployment(["a"]).replace("slack-welcomer", "other"));
    expect(after[0].identity).not.toBe(before[0].identity);
  });
});
