/**
 * `chant terraform report`, against a hand-built composed plan in the shape of
 * choudoufu's `show -json`: three module calls (network, app, edge), a subnet
 * whose id the plan cannot know, a security group placed in it, an in-place
 * update, and a sensitive value. The post-apply plan carries the state.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { addToIndex, dirStore, httpStore, runFactsFromEnv, slicePlan, terraformReport, topModule, writeReport } from "./report";
import { parseReportArgs } from "./commands";

const rc = (address: string, module: string, type: string, name: string, actions: string[], change: Record<string, unknown>) => ({
  address, module_address: module, mode: "managed", type, name, provider_name: "registry.terraform.io/hashicorp/aws", change: { actions, ...change },
});

const PLAN = {
  format_version: "1.2",
  resource_changes: [
    rc("module.network.aws_subnet.new", "module.network", "aws_subnet", "new", ["create"], {
      before: null, after: { cidr_block: "10.0.9.0/24", tags: { Name: "new" } }, after_unknown: { id: true, arn: true }, after_sensitive: {},
    }),
    rc("module.network.aws_vpc.main", "module.network", "aws_vpc", "main", ["update"], {
      before: { cidr_block: "10.0.0.0/16", enable_dns_support: true }, after: { cidr_block: "10.0.0.0/16", enable_dns_support: false }, after_unknown: {}, before_sensitive: {}, after_sensitive: {},
    }),
    rc("module.app.aws_security_group.sg", "module.app", "aws_security_group", "sg", ["create"], {
      before: null, after: { name: "tgc-sg" }, after_unknown: { id: true, vpc_id: true }, after_sensitive: { password: true },
    }),
    rc("module.edge.aws_route_table.rt", "module.edge", "aws_route_table", "rt", ["delete", "create"], {
      before: { vpc_id: "vpc-1" }, after: { vpc_id: "vpc-2" }, after_unknown: {}, replace_paths: [["vpc_id"]], before_sensitive: {}, after_sensitive: {},
    }),
    rc("module.edge.aws_route.keep", "module.edge", "aws_route", "keep", ["no-op"], { before: { x: 1 }, after: { x: 1 }, after_unknown: {} }),
  ],
};

const AFTER = {
  format_version: "1.2",
  resource_changes: [],
  prior_state: {
    values: {
      root_module: {
        child_modules: [
          { address: "module.network", resources: [{ address: "module.network.aws_subnet.new", values: { id: "subnet-123", arn: "arn:aws:ec2:::subnet-123" }, sensitive_values: {} }] },
          { address: "module.app", resources: [{ address: "module.app.aws_security_group.sg", values: { id: "sg-9", vpc_id: "vpc-2" }, sensitive_values: { vpc_id: true } }] },
        ],
      },
    },
  },
};

const RUN = { project: "forgejo:3000/admin/demo-terragrunt-choudoufu", commit: "abc123", job_url: "http://forgejo:3000/admin/x/actions/runs/7", pull_request: "4" };
const FINISHED = "2026-10-24T10:00:00Z";
const base = { plan: PLAN, run: RUN, binary: "choudoufu", rootDir: "estates", finished: FINISHED };

const changeOf = (report: any, root: string, address: string) => report.roots.find((r: any) => r.path === root).changes.find((c: any) => c.address === address);

describe("slicing the composed plan", () => {
  test("a module is taken off the addresses", () => {
    expect(topModule("module.network.aws_subnet.new")).toBe("network");
    expect(topModule("module.net[0].module.inner")).toBe("net");
    expect(topModule("aws_vpc.main")).toBeUndefined();
    const s = slicePlan(PLAN, "network") as any;
    expect(s.resource_changes.map((r: any) => r.address)).toEqual(["aws_subnet.new", "aws_vpc.main"]);
    expect(s.resource_changes[0].module_address).toBeUndefined();
  });
});

describe("terraformReport, tf-plan", () => {
  const { report, path, row } = terraformReport({ ...base, stage: "tf-plan" });
  const r = report as any;

  test("one root per module, in the roots' directory, as one composed wave", () => {
    expect(r.schema).toBe("terragucci.report/v1");
    expect(r.roots.map((x: any) => x.path)).toEqual(["estates/app", "estates/edge", "estates/network"]);
    expect(r.roots.every((x: any) => x.status === "planned" && x.composed.wave === 1)).toBe(true);
    expect(r.roots.find((x: any) => x.path === "estates/network").composed.module).toBe("module.network");
    expect(r.waves).toHaveLength(1);
    expect(r.waves[0].roots).toEqual(["estates/app", "estates/edge", "estates/network"]);
    expect(r.waves[0].state).toBe("planned");
    expect(r.waves[0].composed.members.map((m: any) => m.module)).toEqual(["module.app", "module.edge", "module.network"]);
    expect(r.compose).toEqual({ roots: ["estates/app", "estates/edge", "estates/network"], max: 3, wave: 1, estate: true });
  });

  test("a value the plan cannot know is unknown, with no after", () => {
    const c = changeOf(r, "estates/network", "aws_subnet.new");
    expect(c.action).toBe("create");
    const id = c.attributes.find((a: any) => a.path === "id");
    expect(id.unknown).toBe(true);
    expect(id.after).toBeUndefined();
    expect(c.attributes.find((a: any) => a.path === "cidr_block").after).toBe("10.0.9.0/24");
  });

  test("an update carries before and after; a no-op is counted but not listed", () => {
    const c = changeOf(r, "estates/network", "aws_vpc.main");
    expect(c.attributes).toEqual([{ path: "enable_dns_support", before: true, after: false }]);
    expect(r.roots.find((x: any) => x.path === "estates/edge").counts).toEqual({ replace: 1, "no-op": 1 });
    expect(changeOf(r, "estates/edge", "aws_route.keep")).toBeUndefined();
  });

  test("totals, named replacements and the index row agree", () => {
    expect(r.totals).toMatchObject({ create: 2, update: 1, replace: 1, delete: 0 });
    expect(r.totals_roots).toBe(3);
    expect(r.named).toEqual([expect.objectContaining({ root: "estates/edge", address: "aws_route_table.rt", action: "replace" })]);
    expect(path).toBe("2026/10/abc123/tf-plan");
    expect(row).toMatchObject({ project: RUN.project, stage: "tf-plan", path, roots: 3, changed: 3, totals: { create: 2, update: 1, replace: 1, delete: 0 }, pull_request: "4", destroys: ["estates/edge: aws_route_table.rt"] });
    expect(row.applied).toBeUndefined();
    expect(r.change_set).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
  });

  test("the same plan gives the same report", () => {
    expect(terraformReport({ ...base, stage: "tf-plan" }).report).toEqual(report);
  });
});

describe("terraformReport, tf-apply", () => {
  const { report, row } = terraformReport({ ...base, stage: "tf-apply", applied: AFTER, finished: "2026-10-24T10:05:00Z" });
  const r = report as any;

  test("the values the plan left unknown are read from the state", () => {
    const id = changeOf(r, "estates/network", "aws_subnet.new").attributes.find((a: any) => a.path === "id");
    expect(id).toEqual({ path: "id", after: "subnet-123" });
    const arn = changeOf(r, "estates/network", "aws_subnet.new").attributes.find((a: any) => a.path === "arn");
    expect(arn.after).toBe("arn:aws:ec2:::subnet-123");
  });

  test("a sensitive value stays unwritten, one the state lacks stays unknown", () => {
    const sg = changeOf(r, "estates/app", "aws_security_group.sg").attributes;
    expect(sg.find((a: any) => a.path === "vpc_id")).toEqual({ path: "vpc_id", sensitive: true });
    expect(sg.find((a: any) => a.path === "id").after).toBe("sg-9");
  });

  test("the wave is applied, with each member's changes done, and the row says when", () => {
    expect(r.waves[0].state).toBe("applied");
    expect(r.waves[0].composed.members.find((m: any) => m.root === "estates/network")).toMatchObject({ apply: "applied", changes: { done: 2, planned: 2 }, state: "written" });
    expect(row.applied).toBe("2026-10-24T10:05:00Z");
    expect(row.path).toBe("2026/10/abc123/tf-apply");
  });

  test("an apply report without the post-apply plan is refused", () => {
    expect(() => terraformReport({ ...base, stage: "tf-apply" })).toThrow(/post-apply plan/);
  });
});

describe("writing", () => {
  test("report.json, the project's index and the prefix's, merged with an earlier row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-report-"));
    const store = dirStore(dir);
    const plan = terraformReport({ ...base, stage: "tf-plan" });
    const apply = terraformReport({ ...base, stage: "tf-apply", applied: AFTER, finished: "2026-10-24T10:05:00Z" });
    expect(await writeReport(store, plan)).toEqual([`${RUN.project}/2026/10/abc123/tf-plan/report.json`, `${RUN.project}/index.json`, "index.json"]);
    await writeReport(store, apply);
    await writeReport(store, apply);
    const project = JSON.parse(readFileSync(join(dir, RUN.project, "index.json"), "utf8"));
    expect(project.schema).toBe("terragucci.report-index/v1");
    expect(project.reports.map((x: any) => [x.stage, x.path])).toEqual([["tf-apply", "2026/10/abc123/tf-apply"], ["tf-plan", "2026/10/abc123/tf-plan"]]);
    const top = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    expect(top.reports[1].path).toBe(`${RUN.project}/2026/10/abc123/tf-plan`);
    const stored = JSON.parse(readFileSync(join(dir, RUN.project, "2026/10/abc123/tf-apply/report.json"), "utf8"));
    expect(stored.run.stage).toBe("tf-apply");
  });

  test("an unreadable index starts again from the row", () => {
    expect(addToIndex("{nope", terraformReport({ ...base, stage: "tf-plan" }).row).reports).toHaveLength(1);
  });

  test("the http store reads a 404 as no object and puts unsigned", async () => {
    const seen: string[] = [];
    const objects = new Map<string, string>();
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PUT") {
        objects.set(url, String(init.body));
        return new Response("", { status: 200 });
      }
      return objects.has(url) ? new Response(objects.get(url)!) : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const store = httpStore("http://floci:4566/demo-reports/demo/", fake);
    await writeReport(store, terraformReport({ ...base, stage: "tf-plan" }));
    expect(seen[0]).toBe("PUT http://floci:4566/demo-reports/demo/forgejo%3A3000/admin/demo-terragrunt-choudoufu/2026/10/abc123/tf-plan/report.json");
    expect(seen).toContain("GET http://floci:4566/demo-reports/demo/index.json");
    expect(JSON.parse(objects.get("http://floci:4566/demo-reports/demo/index.json")!).reports).toHaveLength(1);
  });
});

describe("the run's facts and the verb's flags", () => {
  test("a Forgejo environment names the project as terragucci does", () => {
    const f = runFactsFromEnv({ GITHUB_REPOSITORY: "admin/demo", GITHUB_SERVER_URL: "http://forgejo:3000", GITHUB_SHA: "deadbeef", GITHUB_RUN_ID: "9", FORGEJO_ACTIONS: "true" }, { pullRequest: "12" });
    expect(f).toEqual({
      project: "forgejo:3000/admin/demo", commit: "deadbeef", job_url: "http://forgejo:3000/admin/demo/actions/runs/9",
      commit_url: "http://forgejo:3000/admin/demo/commit/deadbeef", pull_request: "12", pull_request_url: "http://forgejo:3000/admin/demo/pulls/12",
    });
    expect(() => runFactsFromEnv({})).toThrow(/--project and --commit/);
  });

  test("flags", () => {
    expect(parseReportArgs(["--stage", "tf-plan", "--plan", "p.json", "--out", "d"]).values.get("--out")).toBe("d");
    expect(() => parseReportArgs(["--stage", "tf-apply", "--plan", "p.json", "--out", "d"])).toThrow(/--applied/);
    expect(() => parseReportArgs(["--stage", "tf-plan", "--plan", "p.json"])).toThrow(/--out/);
    expect(() => parseReportArgs(["--stage", "tf-plan", "--plan", "p.json", "--out", "d", "--to", "u"])).toThrow(/--out/);
    expect(() => parseReportArgs(["--bogus"])).toThrow();
  });
});
